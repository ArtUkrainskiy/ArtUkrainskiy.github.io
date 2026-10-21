---
title: "One mutex for every row: mysqlnd statistics in thread-based PHP"
description: "In thread-safe PHP builds such as FrankenPHP, mysqlnd takes one process-wide lock on every statistics update. With MySQL, FrankenPHP spends 7–32% more CPU per request than with statistics off. PHP-FPM is not affected. One php.ini line removes the cost today; a patch with atomic counters brings it to 1–3%."
pubDatetime: 2026-10-19T18:00:00Z
draft: false
tags:
  - performance
  - php
  - mysql
---

PHP has two kinds of builds. The usual one, NTS (non-thread-safe), serves one request per process at a time: PHP-FPM, the CLI, RoadRunner, Swoole. ZTS (Zend Thread Safety) builds serve requests on several threads of one process: FrankenPHP, Apache with a threaded MPM and a ZTS PHP, ext/parallel.

mysqlnd is the MySQL client library behind PDO MySQL and mysqli. It keeps client statistics, and they are on by default. In ZTS builds every statistics update takes a mutex, a lock that only one thread can hold at a time, and one of those mutexes is shared by all threads of the process. It is taken on every counted packet and row.

In short:

- **Who is affected:** ZTS builds that talk to MySQL or MariaDB through PDO or mysqli. The lock is in the client, so the server doesn't matter. I measured with MySQL 8.4. PHP-FPM, the CLI, RoadRunner and Swoole are NTS builds and don't pay anything. To check your build, run `php -i | grep 'Thread Safety'`.
- **What it costs:** CPU per request of the PHP process, statistics on against statistics off, with FrankenPHP on one desktop machine. With PHP 8.5.11 and the JSON API request of the [12-stack comparison](/posts/web-request-cost-stage-1/), it is 7% at 1000 req/s and 32% with the database saturated. In the worst case I measured, a minimal query on php-src master with 8 cores split over the CPU's two L3 caches, it is 91%, and throughput drops from 28,855 to 21,450 req/s.
- **What to do today:** set `mysqlnd.collect_statistics = 0`, unless something reads the client statistics ([details below](#what-to-do-now)). With statistics off there are no locks at all, so this is no reason to avoid FrankenPHP.
- **The fix:** [php/php-src#24448](https://github.com/php/php-src/pull/24448) replaces the lock with relaxed atomic counters and keeps the statistics. The lock only ever guarded the additions: reads were already unlocked and counters were never updated together, so atomic additions give the same guarantees. With the PR on master the cost is 0.6–1.4%, and a prototype of the same idea on PHP 8.5.11 gives 0.8–2.8%. The patch targets master because it changes the layout of a public struct under ZTS. On 22 October 2026 the PR is open and under review. The issue is [php/php-src#24447](https://github.com/php/php-src/issues/24447).

Everything below is measured on a desktop AMD Ryzen 9 5950X. The data and scripts are public. The full API with PHP 8.5.11 is in [web-request-cost](https://github.com/ArtUkrainskiy/web-request-cost/tree/ba122ac9e4feae2d883d4a815720cd4d264b32cd/results/2026-10-mysqlnd). The minimal workload on php-src master, the lock count and the correctness checks are in [php-src-bench](https://github.com/ArtUkrainskiy/php-src-bench/tree/a52dd550dfad0805d08d40d3958c5c800540f768/reports/mysqlnd-zts-stats).

## Contents

## How it showed up

The [comparison of 12 web stacks](/posts/web-request-cost-stage-1/) measures the CPU of one JSON API request on PostgreSQL and on MySQL. The request looks up a token, then reads 20 posts with authors, tags and comment counts. In a run on a cloud VM, FrankenPHP cost twice as much CPU per request on MySQL as on PostgreSQL. PHP-FPM, with the same PHP code and the same driver, cost less on MySQL.

A `perf` profile of FrankenPHP there had lock functions at the top of more than a quarter of the samples: `__pv_queued_spin_lock_slowpath` 18%, `pthread_mutex_lock` and `pthread_mutex_unlock` 9%. In three runs on that VM on the same day, at 50 clients, statistics on cost 2.2, 2.4 and 4.2 times the CPU per request of statistics off. These cloud runs only pointed me to the problem. Their data is not published, and nothing else in this post relies on them.

## The cause

mysqlnd counts what it does: bytes, packets, queries, rows fetched and buffered. There are 163 counters, shown by `mysqli_get_client_stats()`, `mysqli_get_connection_stats()` and the mysqlnd section of `phpinfo()`. Every update goes through one macro ([`mysqlnd_statistics.h`](https://github.com/php/php-src/blob/1c9242e7fecbaff646b677b46cf9962831fc2fa2/ext/mysqlnd/mysqlnd_statistics.h#L19-L32)):

```c
#ifdef ZTS
#define MYSQLND_STATS_LOCK(stats) tsrm_mutex_lock((stats)->LOCK_access)
#define MYSQLND_STATS_UNLOCK(stats) tsrm_mutex_unlock((stats)->LOCK_access)
#else
#define MYSQLND_STATS_LOCK(stats)
#define MYSQLND_STATS_UNLOCK(stats)
#endif

#define MYSQLND_STATS_UPDATE_VALUE(stats, statistic, value) \
	{ \
			MYSQLND_STATS_LOCK(stats); \
			(stats)->values[(statistic)] += (value); \
			MYSQLND_STATS_UNLOCK(_p_s); \
	}
```

The unlock really says `_p_s`, not `stats`. Every caller passes a variable named `_p_s`, so it works, and the patch removes these lock macros.

The connection macros update two sets of counters: the connection's own, and `mysqlnd_global_stats`, one object for the whole process ([`mysqlnd.h`](https://github.com/php/php-src/blob/1c9242e7fecbaff646b677b46cf9962831fc2fa2/ext/mysqlnd/mysqlnd.h#L262-L276)). A connection is used by one thread, so its mutex never makes anyone wait. The global one is taken by every thread.

The statistics are on by default: `mysqlnd.collect_statistics=1` in [`php_mysqlnd.c`](https://github.com/php/php-src/blob/1c9242e7fecbaff646b677b46cf9962831fc2fa2/ext/mysqlnd/php_mysqlnd.c#L151) and in `php.ini-production`. In NTS builds the lock macros are empty, which is why FPM doesn't pay. The code is the same in PHP 8.4, 8.5 and master.

## Counting the locks

A bpftrace probe on `pthread_mutex_lock` inside the FrankenPHP process counts how often this happens. The workload is minimal: the official image `dunglas/frankenphp:1.13-php8.5.11`, 16 PHP threads, one prepared `SELECT` of 20 rows per request ([script](https://github.com/ArtUkrainskiy/php-src-bench/blob/a52dd550dfad0805d08d40d3958c5c800540f768/reports/mysqlnd-zts-stats/repro/count-locks.sh), [output](https://github.com/ArtUkrainskiy/php-src-bench/blob/a52dd550dfad0805d08d40d3958c5c800540f768/reports/mysqlnd-zts-stats/data/locks.txt)):

| `pthread_mutex_lock` per request | statistics on | `collect_statistics=0` |
|---|---:|---:|
| all | 722.7 | 0 |
| the one global mutex | 371.4 | — |
| the 16 per-connection mutexes | 351.4 | — |

Every mutex lock of the process is a statistics update: with statistics off there are none. The global mutex is the address with the most `futex` calls, 34–38 per request, which means threads wait for it. None of the per-connection mutexes is among the 20 addresses with the most.

Tracing slows the server from about 22,000 to about 4,400 req/s. So these counts show where threads wait, not how much they wait without tracing.

## What it costs

All numbers here are CPU time per request of the PHP process, statistics on against statistics off in the same build. It is a cost, not a response time.

### The full API, PHP 8.5.11

This is the JSON API request of the stack comparison, on its harness and builds. FrankenPHP 1.13.1 runs 16 workers on 4 cores (8 hardware threads). MySQL 8.4.11 runs on other cores of the same host. Statistics on (the default) alternate with `mysqlnd.collect_statistics=0`, 3 passes each ([data](https://github.com/ArtUkrainskiy/web-request-cost/tree/ba122ac9e4feae2d883d4a815720cd4d264b32cd/results/2026-10-mysqlnd)). CPU per request of the FrankenPHP container, median of the passes:

| load | statistics on | statistics off | cost of statistics |
|---|---:|---:|---:|
| 1000 req/s | 0.342 ms | 0.317 ms | +7.2% |
| 2000 req/s | 0.327 ms | 0.298 ms | +9.4% |
| 4000 req/s | 0.327 ms | 0.277 ms | +17.7% |
| 50 clients, database saturated | 0.411 ms | 0.312 ms | +32.2% |

The cost grows with the load: the more requests run at the same time, the more threads wait for the same mutex. The database's CPU per request is the same with and without statistics. Only PHP pays.

Per pass, the cost ranges from +6.2% to +9.5% at 1000 req/s and from +31.1% to +33.4% with the database saturated ([tables](https://github.com/ArtUkrainskiy/web-request-cost/blob/ba122ac9e4feae2d883d4a815720cd4d264b32cd/results/2026-10-mysqlnd/tables.md)). Latency doesn't change on these 4 cores: p99 at the fixed rates is 4.8–6.6 ms with statistics on and 5.0–6.5 ms with statistics off. At saturation throughput drops by 1.3%, from 6,408 to 6,323 req/s, because the database is the limit there.

### Where the threads run

The 5950X has two CCDs, groups of 8 cores with their own L3 cache. To see how the placement of the threads matters, I ran the minimal workload with 16 threads on 4 or 8 cores, on one CCD or split evenly over both. This uses FrankenPHP built against php-src master of 18 October 2026 ([`b7256ee`](https://github.com/php/php-src/commit/b7256eee3018928d265830e5f523dcc848dea2b6)), so that the patch can be measured on the same base. FrankenPHP 1.13.1 needs two small source changes to build against master, the same for every build; [the report](https://github.com/ArtUkrainskiy/php-src-bench/tree/a52dd550dfad0805d08d40d3958c5c800540f768/reports/mysqlnd-zts-stats) lists them. CPU per request of the FrankenPHP process, median of 10–15 alternating passes:

| FrankenPHP cores | statistics on | statistics off | cost of statistics |
|---|---:|---:|---:|
| 4, one CCD | 0.303 ms | 0.271 ms | +12% |
| 4, two on each CCD | 0.355 ms | 0.290 ms | +23% |
| 8, one CCD | 0.381 ms | 0.271 ms | +41% |
| 8, four on each CCD | 0.527 ms | 0.275 ms | +91% |

I pinned the threads by hand to compare the placements. I didn't measure threads left to the scheduler, which can put them on either CCD.

Both factors raise the cost. More cores let more threads hold and wait for the mutex at the same time. At the same number of cores, splitting them over two CCDs about doubles the cost. That fits the mutex's cache line moving between the two L3 caches on every lock. In the last placement throughput drops from 28,855 to 21,450 req/s. Cycles grow faster than instructions there, +91% against +32%, which fits threads waiting rather than working. I didn't trace that separately.

## What to do now

If you run PHP with threads and talk to MySQL or MariaDB through PDO or mysqli, set:

```ini
mysqlnd.collect_statistics = 0
```

The threaded setups are FrankenPHP, Apache with `mpm_event` or `mpm_worker` and a ZTS PHP, and ext/parallel. Only FrankenPHP was measured here, but the others take the same lock.

In the official FrankenPHP image, put that line into a file in `/usr/local/etc/php/conf.d/`, or set it in the Caddyfile with `php_ini mysqlnd.collect_statistics 0` in the `frankenphp` block.

The setting is safe unless something reads `mysqli_get_client_stats()`, `mysqli_get_connection_stats()` or the mysqlnd section of `phpinfo()`. I haven't checked which APM agents and profilers read them. To check whether your build is ZTS, run `php -i | grep 'Thread Safety'`. NTS builds have no lock to remove.

## The fix

The mutex protects nothing but the additions:

- `mysqlnd_fill_stats_hash()`, which builds the arrays for the functions above, already reads the counters [without it](https://github.com/php/php-src/blob/1c9242e7fecbaff646b677b46cf9962831fc2fa2/ext/mysqlnd/mysqlnd_statistics.c#L195-L207);
- nothing resets the counters;
- the macros that update two or three counters take the lock once per counter, so related counters were never updated together.

So a reader never got a consistent snapshot, and each counter is independent. A relaxed atomic addition gives exactly what the mutex gave: no update is lost, and no order between counters is promised. The patch also makes the reads atomic. Under ZTS the counters become `atomic_uint_least64_t`, and `mysqlnd_fill_stats_hash()` reads them with `atomic_load_explicit(..., memory_order_relaxed)`. The unlocked read was a data race before, and on 32-bit targets a 64-bit read could tear. Both are gone.

The patch ([`mysqlnd-stats-atomic.patch`](https://github.com/ArtUkrainskiy/php-src-bench/blob/a52dd550dfad0805d08d40d3958c5c800540f768/reports/mysqlnd-zts-stats/mysqlnd-stats-atomic.patch), for master) uses C11 atomics. php-src master uses them since [#23927](https://github.com/php/php-src/pull/23927) removed its own `zend_atomic.h`, and on Windows it compiles with MSVC's `/experimental:c11atomics`. The Windows x64 ZTS job of php-src's CI builds the PR and runs the mysqli and pdo_mysql tests. Its only failure is an unrelated CLI server test.

```c
#ifdef ZTS
#define MYSQLND_STATS_UPDATE_VALUE(stats, statistic, value) \
	atomic_fetch_add_explicit(&(stats)->values[(statistic)], (value), memory_order_relaxed)
#else
#define MYSQLND_STATS_UPDATE_VALUE(stats, statistic, value) \
	((stats)->values[(statistic)] += (value))
#endif
```

What else the patch changes:

- **The mutex.** `LOCK_access` is used only by these macros, `mysqlnd_stats_init()` and `mysqlnd_stats_end()`. The mutex, its allocation and its free are removed.
- **NTS.** NTS builds keep plain `uint64_t` and `+=`. The machine code of the 455 mysqlnd functions in an NTS build is the same as on master (GCC 13.3, disassembly compared with addresses normalized).
- **C++.** C++ extensions that include the mysqlnd headers see `std::atomic_uint_least64_t` and the matching functions through a few `using std::` declarations in `mysqlnd_structs.h`, under ZTS only. mysql_xdevapi uses the statistics macros.
- **libatomic.** After review, the PR also links mysqlnd with `-latomic` in ZTS builds on platforms that need it for 64-bit atomics.
- **Compatibility.** `struct st_mysqlnd_stats` is in a public header and its layout changes under ZTS. So the patch is for master only, where extensions are rebuilt anyway.

On x86-64 the additions compile to `lock`-prefixed instructions. In `php_mysqlnd_rowp_read_text_protocol`, the four `tsrm_mutex_lock` calls become four `lock add` instructions.

Other ways were possible:

- **Per-thread counters summed on read.** These avoid the shared cache line. But the counters of finished threads have to be kept somewhere, and it is more code.
- **Plain `+=` for the per-connection counters.** Only the thread that uses the connection touches them, so this would save the remaining uncontended `lock add`s. It needs a second set of macros.
- **Statistics off by default in ZTS builds.** This changes what `mysqli_get_client_stats()` returns, while the patch keeps the behaviour.

With the patch's cost at 1–3%, I kept the smallest change.

## What it gives

The same measurements with atomic counters, as the cost of statistics on over statistics off.

On php-src master with the minimal workload, this is the patch of the PR:

| FrankenPHP cores | master | patch |
|---|---:|---:|
| 4, one CCD | +12% | +0.6% |
| 4, two on each CCD | +23% | +1.4% |
| 8, one CCD | +41% | +0.8% |
| 8, four on each CCD | +91% | +1.0% |
| 4, one CCD, binary protocol (native prepares) | +14% | +1.4% |

The patch is written for master. On the full API with PHP 8.5.11 I measured a [prototype](https://github.com/ArtUkrainskiy/web-request-cost/blob/ba122ac9e4feae2d883d4a815720cd4d264b32cd/results/2026-10-mysqlnd/mysqlnd-atomic-php-8.5.11.patch) of the same idea with the compiler's `__atomic_fetch_add`:

| load | the mutex | atomic counters |
|---|---:|---:|
| 1000 req/s | +7.2% | +1.6% |
| 2000 req/s | +9.4% | +0.8% |
| 4000 req/s | +17.7% | +1.9% |
| 50 clients, database saturated | +32.2% | +2.8% |

What is left is the global counters, still on cache lines shared by all threads, and about 350 uncontended `lock add`s per request on the per-connection counters. With statistics off, the patch and master run the same code. In the 10–15-pass series they measure within 0.3% of each other.

In the master-based series, passes of both builds jump between two states, for example about 1.05 and 1.16 million cycles per request with statistics off on 4 cores of one CCD. The instructions differ between the states too. I haven't found why. The medians are stable, but small differences between rows, like +0.6% against +1.4%, are within that noise. The [report](https://github.com/ArtUkrainskiy/php-src-bench/tree/a52dd550dfad0805d08d40d3958c5c800540f768/reports/mysqlnd-zts-stats) has every pass. The full-API series doesn't show this: its passes for the atomic counters range from +0.0% to +3.0%.

## Checking that it counts correctly

A faster counter that loses updates would be worse than the mutex. [`counts.sh`](https://github.com/ArtUkrainskiy/php-src-bench/blob/a52dd550dfad0805d08d40d3958c5c800540f768/reports/mysqlnd-zts-stats/scripts/counts.sh) sends exactly 50,000 requests, 50 at a time, to FrankenPHP with 16 threads, and reads `mysqli_get_client_stats()` before and after:

| build | `com_query` | `rows_fetched_from_server_normal` |
|---|---:|---:|
| master | 50,000 | 1,000,000 |
| patch | 50,000 | 1,000,000 |
| racy variant: `atomic_store(atomic_load() + value)` | 49,460 | 997,554 |

The racy variant shows that the check can fail. A load and a store without one atomic addition between them lose about 1% of the updates under this load, and the check sees it.

Beyond that:

- the `ext/mysqlnd`, `ext/mysqli` and `ext/pdo_mysql` tests give the same result on the patch as on master: 763 of 796 pass, 28 are skipped, 4 are expected to fail, and one DSN test fails on both in my setup;
- `--enable-werror` builds pass with GCC 13.3 and clang 18.1, ZTS and NTS;
- a C++ file using the statistics macros compiles under ZTS with g++ 13 and clang++ 18 and 20 in C++11, C++17 and C++20.

Not tested:

- Windows x86 ZTS, and a C++ extension including the mysqlnd headers with MSVC;
- 32-bit Linux beyond php-src's CI job and Debian armel under qemu, where configure picks `-latomic` and the statistics count correctly;
- ARM64, more than one socket, Apache with a threaded MPM, ext/parallel, TSan;
- building mysql_xdevapi against the patch.
