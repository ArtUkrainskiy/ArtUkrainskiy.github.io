---
title: "One mutex for every row: mysqlnd statistics in thread-based PHP"
description: "In thread-safe PHP builds, mysqlnd locks a process-wide mutex on every statistics update. How it showed up, what it costs FrankenPHP with MySQL depending on the load and on where the threads run, and a patch with relaxed atomics that keeps the statistics and brings their cost down from 7–91% to 1–3%."
pubDatetime: 2026-10-19T18:00:00Z
draft: false
tags:
  - performance
  - php
  - mysql
---

PHP has two kinds of builds. The usual one, NTS (non-thread-safe), serves one request per process at a time: PHP-FPM, the CLI, RoadRunner, Swoole. ZTS (Zend Thread Safety) builds serve requests on several threads of one process: FrankenPHP, Apache with a threaded MPM and a ZTS PHP, ext/parallel. In ZTS builds, mysqlnd — the MySQL client library behind PDO MySQL and mysqli — locks a mutex shared by all threads of the process on every counted packet and row, because it keeps client statistics, and they are on by default.

On one machine, with FrankenPHP and MySQL, the statistics add 7–32% to the CPU per request of the PHP process depending on the load, and up to 91% depending on where its threads run. A patch that replaces the mutex with relaxed atomic additions keeps the statistics and brings their cost to 1–3%.

Everything below is measured on a desktop AMD Ryzen 9 5950X, and the data and scripts are public: the measurements with PHP 8.5.11 and a full API are in [web-request-cost](https://github.com/ArtUkrainskiy/web-request-cost/tree/ba122ac9e4feae2d883d4a815720cd4d264b32cd/results/2026-10-mysqlnd); those on php-src master with a minimal workload, the lock count and the correctness checks are in [php-src-bench](https://github.com/ArtUkrainskiy/php-src-bench/tree/a52dd550dfad0805d08d40d3958c5c800540f768/reports/mysqlnd-zts-stats).

## Contents

## How it showed up

The [comparison of 12 web stacks](/posts/web-request-cost-stage-1/) measures the CPU of one JSON API request — a token lookup, then 20 posts with authors, tags and comment counts — on PostgreSQL and on MySQL. In a run on a cloud VM, FrankenPHP cost twice as much CPU per request on MySQL as on PostgreSQL, while PHP-FPM, with the same PHP code and the same driver, cost less on MySQL. A `perf` profile of FrankenPHP there had lock functions at the top of more than a quarter of the samples (`__pv_queued_spin_lock_slowpath` 18%, `pthread_mutex_lock` and `pthread_mutex_unlock` 9%). The cloud runs are separate from everything else in this post, and their data is not published.

## The cause

mysqlnd counts what it does: bytes, packets, queries, rows fetched and buffered, 163 counters in all, which `mysqli_get_client_stats()`, `mysqli_get_connection_stats()` and the mysqlnd section of `phpinfo()` show. Every update goes through one macro ([`mysqlnd_statistics.h`](https://github.com/php/php-src/blob/1c9242e7fecbaff646b677b46cf9962831fc2fa2/ext/mysqlnd/mysqlnd_statistics.h#L19-L32)):

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

The connection macros update two sets of counters: the connection's own, and `mysqlnd_global_stats`, one object for the whole process ([`mysqlnd.h`](https://github.com/php/php-src/blob/1c9242e7fecbaff646b677b46cf9962831fc2fa2/ext/mysqlnd/mysqlnd.h#L262-L276)). A connection is used by one thread, so its mutex is never contended; the global one is taken by every thread. The statistics are on by default (`mysqlnd.collect_statistics=1` in [`php_mysqlnd.c`](https://github.com/php/php-src/blob/1c9242e7fecbaff646b677b46cf9962831fc2fa2/ext/mysqlnd/php_mysqlnd.c#L151) and in `php.ini-production`). In NTS builds the lock macros are empty, which is why FPM does not pay. The code is the same in PHP 8.4, 8.5 and master.

## Counting the locks

A bpftrace uprobe on `pthread_mutex_lock` inside the FrankenPHP process counts how often this happens. The workload is minimal: the official image `dunglas/frankenphp:1.13-php8.5.11`, 16 PHP threads, one prepared `SELECT` of 20 rows per request ([script](https://github.com/ArtUkrainskiy/php-src-bench/blob/a52dd550dfad0805d08d40d3958c5c800540f768/reports/mysqlnd-zts-stats/repro/count-locks.sh), [output](https://github.com/ArtUkrainskiy/php-src-bench/blob/a52dd550dfad0805d08d40d3958c5c800540f768/reports/mysqlnd-zts-stats/data/locks.txt)):

| `pthread_mutex_lock` per request | statistics on | `collect_statistics=0` |
|---|---:|---:|
| all | 722.7 | 0 |
| the one global mutex | 371.4 | — |
| the 16 per-connection mutexes | 351.4 | — |

Every mutex lock of the process is a statistics update: with statistics off there are none. The address with the most `futex` calls, 34–38 per request, is the global mutex; none of the per-connection mutexes is among the 20 addresses with the most. Tracing slows the server from about 22,000 to about 4,400 req/s, so these counts show where the contention is, not how much of it there is without tracing.

## What it costs

### The full API, PHP 8.5.11

On the harness and builds of the stack comparison: FrankenPHP 1.13.1 with 16 workers on 4 cores (8 hardware threads), MySQL 8.4.11 on other cores of the same host, statistics on (the default) against `mysqlnd.collect_statistics=0`, 3 passes with the variants alternating ([data](https://github.com/ArtUkrainskiy/web-request-cost/tree/ba122ac9e4feae2d883d4a815720cd4d264b32cd/results/2026-10-mysqlnd)). CPU per request of the FrankenPHP container, median of the passes:

| load | statistics on | statistics off | cost of statistics |
|---|---:|---:|---:|
| 1000 req/s | 0.342 ms | 0.317 ms | +7.2% |
| 2000 req/s | 0.327 ms | 0.298 ms | +9.4% |
| 4000 req/s | 0.327 ms | 0.277 ms | +17.7% |
| 50 clients, database saturated | 0.411 ms | 0.312 ms | +32.2% |

The cost grows with the load: the more requests run at the same time, the more threads wait for the same mutex. The database's CPU per request is the same with and without statistics; only PHP pays.

### Where the threads run

The 5950X has two CCDs, groups of 8 cores with their own L3 cache. To see how the placement of the threads matters, I built FrankenPHP against php-src master of 18 October 2026 ([`b7256ee`](https://github.com/php/php-src/commit/b7256eee3018928d265830e5f523dcc848dea2b6)) and ran the minimal workload with its 16 threads on 4 or 8 cores, on one CCD or split evenly over both ([report](https://github.com/ArtUkrainskiy/php-src-bench/tree/a52dd550dfad0805d08d40d3958c5c800540f768/reports/mysqlnd-zts-stats)). FrankenPHP 1.13.1 needs two small source changes to build against master, the same for every build; the report lists them. CPU per request of the FrankenPHP process, median of 10–15 alternating passes:

| FrankenPHP cores | statistics on | statistics off | cost of statistics |
|---|---:|---:|---:|
| 4, one CCD | 0.3029 ms | 0.2705 ms | +12% |
| 4, two on each CCD | 0.3553 ms | 0.2897 ms | +23% |
| 8, one CCD | 0.3810 ms | 0.2714 ms | +41% |
| 8, four on each CCD | 0.5274 ms | 0.2747 ms | +91% |

Both factors raise the cost. More cores let more threads hold and wait for the mutex at the same time. At the same number of cores, splitting them over two CCDs about doubles the cost, consistent with the mutex's cache line moving between the two L3 caches on every lock. In the last placement throughput drops from 28,855 to 21,450 req/s. The cycles grow faster than the instructions there (+91% against +32%), which is consistent with threads waiting rather than executing; that was not traced separately.

In the cloud VM mentioned above (FrankenPHP on 8 of 32 vCPUs of an AMD EPYC 9754, the full API), the CPU per request with statistics on was 2.2, 2.4 and 4.2 times that with statistics off in three runs on the same day, at 50 clients. With netem raising the round trip on loopback to 0.56 ms, it was 1.24 times.

## The fix

The mutex protects nothing but the additions:
- `mysqlnd_fill_stats_hash()`, which builds the arrays for the functions above, already reads the counters [without it](https://github.com/php/php-src/blob/1c9242e7fecbaff646b677b46cf9962831fc2fa2/ext/mysqlnd/mysqlnd_statistics.c#L195-L207);
- nothing resets the counters;
- the macros that update two or three counters take the lock once per counter, so related counters were never updated together.

A reader therefore never got a consistent snapshot, each counter is independent, and a relaxed atomic addition gives exactly what the mutex gave: no update is lost, and no order between counters is promised.

The patch ([`mysqlnd-stats-atomic.patch`](https://github.com/ArtUkrainskiy/php-src-bench/blob/a52dd550dfad0805d08d40d3958c5c800540f768/reports/mysqlnd-zts-stats/mysqlnd-stats-atomic.patch), for master) does this with C11 atomics, which php-src master uses since [#23927](https://github.com/php/php-src/pull/23927) removed its own `zend_atomic.h`:

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
- **Reads.** Under ZTS the counters are `atomic_uint_least64_t`, and `mysqlnd_fill_stats_hash()` reads them with `atomic_load_explicit(..., memory_order_relaxed)`. The unlocked read was a data race before, and on 32-bit targets a 64-bit read could tear. Both are gone.
- **The mutex.** `LOCK_access` is used only by these macros, `mysqlnd_stats_init()` and `mysqlnd_stats_end()`. The mutex, its allocation and its free are removed.
- **NTS.** NTS builds keep plain `uint64_t` and `+=`. The machine code of the 455 mysqlnd functions in an NTS build is the same as on master (GCC 13.3, disassembly compared with addresses normalized).
- **C++.** C++ extensions that include the mysqlnd headers see `std::atomic_uint_least64_t` and the matching functions through a few `using std::` declarations in `mysqlnd_structs.h`, under ZTS only. mysql_xdevapi uses the statistics macros.
- **Compatibility.** `struct st_mysqlnd_stats` is in a public header and its layout changes under ZTS, so the patch is for master only, where extensions are rebuilt anyway.

On x86-64 the additions compile to `lock`-prefixed instructions. In `php_mysqlnd_rowp_read_text_protocol`, the four `tsrm_mutex_lock` calls become four `lock add` instructions.

Other ways were possible:
- **Per-thread counters summed on read.** These avoid the shared cache line, but the counters of finished threads have to be kept somewhere, and it is more code.
- **Plain `+=` for the per-connection counters.** These are only touched by the thread that uses the connection, so this would save the remaining uncontended `lock add`s; it needs a second set of macros.
- **Statistics off by default in ZTS builds.** This changes what `mysqli_get_client_stats()` returns, while the patch keeps the behaviour.

With the patch's cost at 1–3%, I kept the smallest change.

## What it gives

The same measurements with the patch. On the full API with PHP 8.5.11, the change is a [prototype](https://github.com/ArtUkrainskiy/web-request-cost/blob/ba122ac9e4feae2d883d4a815720cd4d264b32cd/results/2026-10-mysqlnd/mysqlnd-atomic-php-8.5.11.patch) of the same idea with `__atomic_fetch_add`. The cost of statistics over statistics off:

| load | the mutex | atomic counters |
|---|---:|---:|
| 1000 req/s | +7.2% | +1.6% |
| 2000 req/s | +9.4% | +0.8% |
| 4000 req/s | +17.7% | +1.9% |
| 50 clients, database saturated | +32.2% | +2.8% |

On php-src master with the minimal workload, the cost of statistics on master and with the patch (each against statistics off of the same build):

| FrankenPHP cores | master | patch | patch, statistics on |
|---|---:|---:|---:|
| 4, one CCD | +12% | +0.6% | 0.2722 ms |
| 4, two on each CCD | +23% | +1.4% | 0.2934 ms |
| 8, one CCD | +41% | +0.8% | 0.2739 ms |
| 8, four on each CCD | +91% | +1.0% | 0.2781 ms |
| 4, one CCD, binary protocol (native prepares) | +14% | +1.4% | 0.3292 ms |

What is left is the global counters, still on cache lines shared by all threads, and about 350 uncontended `lock add` per request on the per-connection counters. With statistics off, the patch and master run the same code; in the 10–15-pass series they measure within 0.3% of each other.

Behind the medians there is a quirk I have not explained. From pass to pass, most variants of both builds run in one of two states, for example about 1.05 or 1.16 million cycles per request with statistics off on 4 cores of one CCD. The instructions differ between the states too, so it is not only the clock frequency. The per-pass ratios therefore range widely, from about −10% to +14% for the patch with statistics on against off, while the medians over 5–15 alternating passes are stable. With only 5 passes of the binary protocol, the two states put the identical "statistics off" builds 7% apart. The [report](https://github.com/ArtUkrainskiy/php-src-bench/tree/a52dd550dfad0805d08d40d3958c5c800540f768/reports/mysqlnd-zts-stats) has every pass. The full-API series, measured differently, has a narrow spread: +0.0% to +3.0% per pass for the atomic counters.

## Checking that it counts correctly

A faster counter that loses updates would be worse than the mutex. [`counts.sh`](https://github.com/ArtUkrainskiy/php-src-bench/blob/a52dd550dfad0805d08d40d3958c5c800540f768/reports/mysqlnd-zts-stats/scripts/counts.sh) sends exactly 50,000 requests, 50 at a time, to FrankenPHP with 16 threads, and reads `mysqli_get_client_stats()` before and after:

| build | `com_query` | `rows_fetched_from_server_normal` |
|---|---:|---:|
| master | 50,000 | 1,000,000 |
| patch | 50,000 | 1,000,000 |
| racy variant: `atomic_store(atomic_load() + value)` | 49,460 | 997,554 |

The racy variant shows that the check can fail: a load and a store without one atomic addition between them lose about 1% of the updates under this load, and the check sees it.

Beyond that:
- the `ext/mysqlnd`, `ext/mysqli` and `ext/pdo_mysql` tests give the same result on the patch as on master: 763 of 796 pass, 28 are skipped, 4 are expected to fail, and one DSN test fails on both in my setup;
- `--enable-werror` builds pass with GCC 13.3 and clang 18.1, ZTS and NTS;
- a C++ file using the statistics macros compiles under ZTS with g++ 13 and clang++ 18 and 20 in C++11, C++17 and C++20.

Not tested:
- Windows: x86 ZTS, and MSVC compiling the header as C++;
- 32-bit Linux builds of PHP;
- targets without lock-free 64-bit atomics, which may need libatomic;
- ARM64, more than one socket, Apache with a threaded MPM, ext/parallel, TSan;
- building mysql_xdevapi against the patch.

## What to do now

If you run PHP with threads and talk to MySQL or MariaDB through PDO or mysqli, set:

```ini
mysqlnd.collect_statistics = 0
```

The threaded setups are FrankenPHP, Apache with `mpm_event` or `mpm_worker` and a ZTS PHP, and ext/parallel. Only FrankenPHP was measured here; the others take the same lock.

The setting is safe unless something reads `mysqli_get_client_stats()`, `mysqli_get_connection_stats()` or the mysqlnd section of `phpinfo()`. To check whether your build is ZTS, run `php -i | grep 'Thread Safety'`. NTS builds have no lock to remove.
