---
title: "12 web stacks on vendor defaults, PostgreSQL and MySQL: what a request costs and what the drivers change"
description: "The same JSON API in PHP, Go, Node, Rust, Java, .NET, Python and Ruby, every stack on its vendors' defaults, measured on one machine against PostgreSQL and MySQL: CPU per request, memory per waiting request, and the problems the measurement found, each with its cause and fix."
pubDatetime: 2026-10-17T21:00:00Z
draft: false
tags:
  - performance
  - php
  - benchmarks
---

Most comparisons of web stacks answer "which one serves more requests per second". I wanted a different answer: how much CPU and memory one ordinary API request costs, on each stack as its vendors ship it, under the same rules for everyone. I wrote the same small JSON API twelve times — PHP (four runtimes), Go, Node (two servers), Rust, Java, .NET, Python and Ruby — and measured all of them on one machine, against PostgreSQL and against MySQL. The result that surprised me most is not about languages at all: on PostgreSQL, whether the database driver keeps prepared statements by default moves the cost more than the runtime does. On MySQL, where most drivers send plain text queries, the database costs about the same for most stacks, and the stack's own CPU matters more.

Everything below comes from the repository [web-request-cost](https://github.com/ArtUkrainskiy/web-request-cost/tree/afd7ea6ee4f2f10069bd029e0c29a705c034861c) at commit `afd7ea6`: the code, the rules, 700 raw records and the script that turns them into [the tables](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/results/2026-10/tables.md). The [mysqlnd finding](#mysqlnd-statistics-in-zts-builds) adds a follow-up series in the same repository; the [Swoole question](#swoole-on-postgresql-at-4000-reqs) cites one run that is not in it.

## Contents

## What was measured

- **The API** ([spec](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/spec/spec.md)): a token lookup in the database, then a page of 20 posts with authors, tags and comment counts, or one post with its comments. Four SQL statements on the main path, the Symfony Demo data ×100 in PostgreSQL 17 or MySQL 8.4. Every implementation must return equivalent JSON content, checked by hashing canonicalized responses (keys sorted, escaping normalized) before measuring.
- **The stacks:** PHP-FPM with nginx, FrankenPHP, RoadRunner and Swoole; Go `net/http`; Node `node:http` and Fastify; Rust hyper; Java Jetty 12 on virtual threads; .NET 10 Kestrel; Python uvicorn; Ruby Puma. PHP has four because they are four execution models (a process per request, a thread per request, a pool of exec'd workers, coroutines); other languages and runtimes are welcome as contributions. Each stack uses a widely used low-level driver of its ecosystem with its plain documented call — the choice of driver is part of the result. Minimal applications without full application frameworks or ORMs (Fastify, a Node HTTP framework, is the one exception); frameworks are the next stage.
- **The rules** ([docs/rules.md](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/docs/rules.md)): runtimes and servers with the production setup their own documentation gives (php.ini-production and OPcache, `uvicorn[standard]`, the `dotnet new web` host, …), database drivers on their defaults, and the same sizing for everyone: process counts per CPU, 24 database connections per stack (PHP workers hold one each: FPM 32, FrankenPHP and RoadRunner 16), one connection per request. The few departures from a default are listed there with the reason for each.
- **The machine:** stack on 4 cores / 8 threads of an AMD Ryzen 9 5950X, databases, load generator and an upstream stub on other cores of the same host, over loopback.
- **The metric:** cgroup CPU time of the stack's containers per request served, and separately the CPU time of the database server per request. At least three passes of every series; the checks in the .NET section below are one pass each.
- **When and what:** measured on 16–17 October 2026 with PHP 8.5.11, Go 1.27.2, Node 24.22, Rust 1.99, Java 25, .NET 10.0.13, Python 3.14.8, Ruby 4.0.7, PostgreSQL 17.11 and MySQL 8.4.11. The load generator for the fixed rates is wrk2, which corrects for coordinated omission.

## CPU per request at the same load

CPU per request is CPU time summed across all cores of the stack's containers (or of the database server), divided by the requests served — a cost, not a latency. Both tables are at a fixed 2000 req/s over 48 connections, without waiting ([section 1a](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/results/2026-10/tables.md)), each sorted by stack + database. Every stack runs the same code against both databases; only the driver changes.

### PostgreSQL

| stack                          | stack CPU | database CPU | stack + database |
| ------------------------------ | --------: | -----------: | ---------------: |
| Java Jetty 12, virtual threads |   0.30 ms |      0.52 ms |          0.82 ms |
| Go net/http                    |   0.40 ms |      0.52 ms |          0.92 ms |
| Python uvicorn                 |   0.40 ms |      0.58 ms |          0.98 ms |
| Ruby Puma                      |   0.36 ms |      1.23 ms |          1.59 ms |
| Node node:http                 |   0.37 ms |      1.26 ms |          1.64 ms |
| Node Fastify                   |   0.39 ms |      1.27 ms |          1.65 ms |
| Rust hyper                     |   0.27 ms |      1.44 ms |          1.71 ms |
| PHP Swoole                     |   0.36 ms |      1.42 ms |          1.77 ms |
| PHP FrankenPHP worker          |   0.42 ms |      1.42 ms |          1.84 ms |
| PHP RoadRunner                 |   0.51 ms |      1.47 ms |          1.98 ms |
| PHP FPM + nginx                |   0.51 ms |      1.50 ms |          2.01 ms |
| .NET 10 Kestrel                |   0.83 ms |      1.31 ms |          2.13 ms |

### MySQL

| stack                          | stack CPU | database CPU | stack + database |
| ------------------------------ | --------: | -----------: | ---------------: |
| PHP Swoole                     |   0.19 ms |      1.16 ms |          1.35 ms |
| PHP FrankenPHP worker          |   0.33 ms |      1.15 ms |          1.48 ms |
| Ruby Puma                      |   0.36 ms |      1.15 ms |          1.51 ms |
| Java Jetty 12, virtual threads |   0.40 ms |      1.12 ms |          1.52 ms |
| Node node:http                 |   0.35 ms |      1.19 ms |          1.53 ms |
| Node Fastify                   |   0.37 ms |      1.20 ms |          1.57 ms |
| Rust hyper                     |   0.27 ms |      1.32 ms |          1.59 ms |
| PHP RoadRunner                 |   0.38 ms |      1.21 ms |          1.59 ms |
| Python uvicorn                 |   0.43 ms |      1.18 ms |          1.61 ms |
| PHP FPM + nginx                |   0.41 ms |      1.27 ms |          1.67 ms |
| Go net/http                    |   0.56 ms |      1.35 ms |          1.91 ms |
| .NET 10 Kestrel                |   0.88 ms |      1.22 ms |          2.10 ms |

Three things stand out. The stacks themselves are close: 0.27–0.51 ms of CPU per request on PostgreSQL and 0.19–0.56 ms on MySQL, with .NET as the exception on both (more on that below). On PostgreSQL the database column splits the table in two: three stacks cost the database about half a millisecond per request, all the others 1.2–1.5 ms. On MySQL there is no such split: the database spends 1.12–1.35 ms for every stack. Latency is unremarkable: at 4000 req/s, p99 is 3.6–10.4 ms for every stack on PostgreSQL except Swoole (78 ms; [below](#swoole-on-postgresql-at-4000-reqs)), and 6.5–8.2 ms for every stack on MySQL.

## PostgreSQL: the driver's default decides

The three cheap rows are exactly the three whose drivers keep prepared statements on each connection by default. Go's [pgx](https://pkg.go.dev/github.com/jackc/pgx/v5) caches them, Java's PgJDBC makes a statement server-side prepared after five uses on a connection, Python's asyncpg caches them too. The others send each statement in a form that PostgreSQL has to parse and plan every time — node-postgres and Ruby's `pg` as unnamed statements, Rust's tokio-postgres and PHP's pdo_pgsql by preparing, executing and closing every statement, Npgsql as unnamed statements plus a session reset when the connection goes back to the pool. What each driver does is in the [driver table of the rules](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/docs/rules.md#database-statements-the-drivers-defaults) and in the [wire check](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/results/2026-10/wire-check.txt): the executes are counted in the database logs, the prepare and close pattern follows from each driver's code.

So with every stack on its defaults, the database work per request differs by a factor of two to three, and that difference — 0.65–0.99 ms — is larger than the whole CPU cost of most runtimes. Rust has the cheapest stack and a total in the expensive half of the table, because of the call it uses ([below](#tokio-postgres-query-prepares-every-statement)). That is why this compares drivers and the calls chosen more than languages.

For PHP-FPM on PostgreSQL I measured four statement configurations — three PDO modes and PgBouncer in front of native prepares ([section 6](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/results/2026-10/tables.md), at C = 50, that is 48 connections, with the database saturated, so the absolute numbers are higher than at 2000 req/s):

| PDO mode                                                      | stack + database per request |
| ------------------------------------------------------------- | ---------------------------: |
| native prepares, direct (pdo_pgsql's default)                 |                      2.60 ms |
| `PDO::ATTR_EMULATE_PREPARES`                                  |                      2.13 ms |
| `Pdo\Pgsql::ATTR_DISABLE_PREPARES`                            |                      2.21 ms |
| native prepares through PgBouncer (`max_prepared_statements`) |                      1.91 ms |

At this workload the default is the most expensive of the four; what each mode does is in [the finding below](#pdo_pgsql-prepares-and-closes-every-statement). Even the cheapest leaves FPM above Go (1.09 ms) and Java (1.11 ms) at the same load: of FPM's gap to Go, PgBouncer closes 46% and emulated prepares 32%.

## MySQL: the stack's own CPU matters more

On MySQL, ten of the twelve stacks send each statement as one text query, with the parameters escaped on the client: PDO in the four PHP stacks (emulated prepares are pdo_mysql's default), mysql2 in both Node stacks, Connector/J, MySqlConnector, asyncmy and trilogy. There is nothing to cache, and the database spends 1.12–1.27 ms per request for all ten; why FPM is at the top of that range and Java at the bottom I have not checked. The two stacks whose drivers prepare on the server cost the database 0.05–0.23 ms more than that — Go 1.35 ms ([below](#go-databasesql-with-go-sql-driver-prepares-every-statement-on-mysql)) and Rust 1.32 ms ([below](#mysql_async-the-pools-session-reset-drops-prepared-statements)) — against differences of 0.65–0.99 ms on PostgreSQL.

With the database cost this close, the stack's CPU explains more of the order than on PostgreSQL. Eight stacks are within 1.48–1.61 ms in total; Swoole is the lowest at 1.35 ms, with 0.19 ms in the stack, and Go and .NET are the highest. FrankenPHP's 0.33 ms includes a lock that every thread of a ZTS PHP build takes in mysqlnd, about 0.03 ms of it at this rate ([below](#mysqlnd-statistics-in-zts-builds)). .NET is the most expensive stack on MySQL as well (0.88 ms), with the same pattern as on PostgreSQL: 1.02 / 0.88 / 0.76 ms at 1000 / 2000 / 4000 req/s.

## .NET: the CPU of waiting for work

.NET has the highest CPU per request in both tables, and that looked wrong. Its CPU per request falls as the load grows: on PostgreSQL 0.97 ms at 1000 req/s, 0.83 at 2000, 0.70 at 4000. Running the rates in descending order on one start gives the same numbers (0.965 / 0.817 / 0.693 ms), so the order of the warm-up does not explain it. A runtime that spends less per request when it has more requests is paying for something while it is idle: the .NET thread pool spins for a while before a worker thread goes to sleep, so that new work does not have to wake it. With that spinning switched off, the stack is at the level of Java and Go ([finding below](#net-thread-pool-spinning)). The published number keeps the default, because that is what stage 1 measures.

## Waiting requests and memory

The third series makes every request wait on another service, 0.1 s or 1 s, as if it called a slow API. Here the execution model matters. For blocking models — PHP-FPM, FrankenPHP, RoadRunner, Puma's threads — the harness provisions a PHP worker per waiting request (RoadRunner accepts at most 500) and about two Puma threads per waiting request, so the series shows what each model needs to hold C requests that wait, not how a fixed production pool behaves. This series ran on PostgreSQL only.

Memory growth per 1000 requests that each wait 1 s ([section 3](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/results/2026-10/tables.md)):

| model                                   | memory per 1000 waiting requests |
| --------------------------------------- | -------------------------------: |
| RoadRunner (a PHP worker per request)   |                         11.5 GiB |
| PHP-FPM (a child process per request)   |                          1.1 GiB |
| FrankenPHP (a PHP thread per request)   |                         0.96 GiB |
| Node (`node:http`, up to 1000 requests) |                         0.90 GiB |
| Java, virtual threads                   |                         0.44 GiB |
| Ruby Puma (threads)                     |                         0.41 GiB |
| .NET                                    |                         0.23 GiB |
| PHP Swoole (coroutines)                 |                         0.11 GiB |
| Go                                      |                         0.10 GiB |
| Rust                                    |                         0.08 GiB |
| Python (asyncio)                        |                         0.02 GiB |

These are slopes of one series, not the size of one request, and they do not carry over to other loads: Node's 0.90 GiB is its heap growing up to 1000 concurrent requests, after which it adds only 0.14 GiB per 1000; Node at about 1000 req/s with a 0.1 s wait uses twice what the slope predicts; and Java's slope varies between passes from 0.39 to 0.76 GiB. What is stable is the order at the ends: RoadRunner far above everything else in every pass ([below](#roadrunner-memory-per-worker)), the coroutine, goroutine, async and Rust stacks at about a tenth of a GiB or less.

## What it costs in money

The repository turns these numbers into dollars with an explicit model ([section 8](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/results/2026-10/tables.md)): 1000 req/s with a 0.1 s wait, PostgreSQL, vCPU at a 60% target utilisation, AWS on-demand prices per vCPU and per GiB. With the database's CPU added, Go, Java and Python come to $49–55 a month and every other stack to $79–105; the stacks alone cost $15–46. It is an amortised resource price, not a bill, and it shows two things: the database is the larger part for most stacks, and at this scale the differences are tens of dollars a month.

## What the measurement found

Each finding has its own heading so that it can be linked from issues and discussions, and each says what it was measured on. Unless a finding says otherwise, the setup is the one above: this API (four SQL statements per request), the stack on 4 cores / 8 threads of a Ryzen 9 5950X, the database on the same host over loopback, numbers from the series in the repository at `afd7ea6`. "Not measured" means the cause is shown but the fix was not run; that is the next stage.

| finding                                                                                                              | observed                                                  | fix                          | effect of the fix                          |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| [mysqlnd statistics in ZTS builds](#mysqlnd-statistics-in-zts-builds)                                                | +9.4% stack CPU for FrankenPHP on MySQL at 2000 req/s, +32% at saturation | php.ini today; patch for php-src | +0.8% and +2.8%                          |
| [pdo_pgsql prepares and closes every statement](#pdo_pgsql-prepares-and-closes-every-statement)                      | three exchanges per statement                             | PDO attribute or PgBouncer   | −15% to −27% stack + database              |
| [.NET thread pool spinning](#net-thread-pool-spinning)                                                               | 0.82 ms stack CPU at 2000 req/s (one-pass check)          | runtime knob                 | 0.32 ms                                    |
| [Puma threads above the pool size](#puma-threads-above-the-pool-size)                                                | p99 1424 ms at 200 clients                                | thread count                 | p99 44 ms                                  |
| [tokio-postgres query prepares every statement](#tokio-postgres-query-prepares-every-statement)                      | 1.44 ms database CPU against 0.52 ms for Go and Java      | another call or the pool's cache | not measured                           |
| [Go database/sql with go-sql-driver prepares every statement on MySQL](#go-databasesql-with-go-sql-driver-prepares-every-statement-on-mysql) | 1.35 ms database CPU, the highest on MySQL | DSN option                   | not measured                               |
| [mysql_async: the pool's session reset drops prepared statements](#mysql_async-the-pools-session-reset-drops-prepared-statements) | every statement prepared again               | pool option                  | not measured                               |

Two more observations have no confirmed cause yet: [Swoole on PostgreSQL at 4000 req/s](#swoole-on-postgresql-at-4000-reqs) and [RoadRunner memory per worker](#roadrunner-memory-per-worker), in [open questions](#open-questions).

### mysqlnd statistics in ZTS builds

- **Setup:** a follow-up series on the same harness, builds, machine and CPUs ([results/2026-10-mysqlnd](https://github.com/ArtUkrainskiy/web-request-cost/blob/ba122ac9e4feae2d883d4a815720cd4d264b32cd/results/2026-10-mysqlnd/README.md)): FrankenPHP 1.13.1 worker mode with 16 workers, PHP 8.5.11 ZTS, this API on MySQL 8.4.11, fixed 1000 / 2000 / 4000 req/s over 48 connections and 50 clients with the database saturated, 3 passes with the variants alternating.
- **What:** in thread-safe (ZTS) PHP builds, every update of mysqlnd's client statistics locks a mutex. One set of statistics is global to the process, so all PHP threads take the same mutex on every counted packet and row (each connection's own statistics take a second, per-connection mutex) ([`mysqlnd_statistics.h`](https://github.com/php/php-src/blob/1c9242e7fecbaff646b677b46cf9962831fc2fa2/ext/mysqlnd/mysqlnd_statistics.h#L19-L32)). Statistics are on by default (`mysqlnd.collect_statistics=1`, [`php_mysqlnd.c`](https://github.com/php/php-src/blob/1c9242e7fecbaff646b677b46cf9962831fc2fa2/ext/mysqlnd/php_mysqlnd.c#L151)). It affects FrankenPHP and other threaded SAPIs with MySQL, through PDO and mysqli; NTS builds — FPM, RoadRunner and Swoole here — compile the lock away. The FrankenPHP row of the MySQL table above runs with statistics on, the default.
- **Measured:** stack CPU per request with statistics on against `mysqlnd.collect_statistics=0`: 0.327 against 0.298 ms at 2000 req/s (+9.4%), +7.2% at 1000 req/s, +17.7% at 4000 req/s and +32% at saturation (0.411 against 0.312 ms); the cost grows with the rate. With the counters made atomic ([prototype patch](https://github.com/ArtUkrainskiy/web-request-cost/blob/ba122ac9e4feae2d883d4a815720cd4d264b32cd/results/2026-10-mysqlnd/mysqlnd-atomic-php-8.5.11.patch)), statistics on cost 0.8–2.8% more than off at every load. The database's CPU is the same for all three.
- **Fix:** today, `mysqlnd.collect_statistics=0` on threaded deployments that do not read `mysqli_get_client_stats()` or the mysqlnd section of `phpinfo()`. For php-src, a patch for master that replaces the mutex with relaxed C11 atomic counters is prepared; [a separate post](/posts/mysqlnd-zts-statistics/) has the patch, its measurements on php-src master and the correctness checks.

### pdo_pgsql prepares and closes every statement

- **Setup:** PHP-FPM with nginx, PostgreSQL 17.11, 50 clients (48 connections), the database saturated, 3 passes ([section 6](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/results/2026-10/tables.md)).
- **What:** with its default native prepares, pdo_pgsql sends a prepare, an execute and a close for every statement: the close is a protocol Close with libpq 17 or newer and a `DEALLOCATE` query before that ([`pgsql_statement.c`](https://github.com/php/php-src/blob/1c9242e7fecbaff646b677b46cf9962831fc2fa2/ext/pdo_pgsql/pgsql_statement.c#L180-L197)). The statement does not outlive the `PDOStatement`, so PostgreSQL parses and plans every statement of every request.
- **Measured:** stack + database per request 2.60 ms by default; 2.13 ms with `PDO::ATTR_EMULATE_PREPARES` (−18%) and 2.21 ms with `Pdo\Pgsql::ATTR_DISABLE_PREPARES` (−15%), which send each statement in one exchange while PostgreSQL still parses it; 1.91 ms with native prepares through PgBouncer and [`max_prepared_statements`](https://www.pgbouncer.org/config.html#max_prepared_statements) (−27%), which keeps the statements prepared on its server connections. PgBouncer's own CPU counts as the stack's: 1.09 ms against 0.59 ms directly. Go and Java at the same load: 1.09 and 1.11 ms.
- **Fix:** connected directly, emulated prepares or `ATTR_DISABLE_PREPARES`; behind PgBouncer in transaction mode, native prepares with `max_prepared_statements`. Statements kept across requests on a persistent connection would remove the per-request parse and plan as PgBouncer does here, without PgBouncer's CPU; that is not measured and an open question for php-src, not a proposal.

### .NET thread pool spinning

- **Setup:** .NET 10 Kestrel, PostgreSQL, fixed rates of 1000 / 2000 / 4000 req/s over 48 connections, one pass per check ([section 1b](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/results/2026-10/tables.md)).
- **What:** the .NET thread pool spins before a worker thread sleeps, so that new work does not have to wake it. On a lightly loaded server that is most of the stack's CPU: 0.96 / 0.82 / 0.69 ms per request at the three rates, the same with the rates run in descending order.
- **Measured:** with `DOTNET_ThreadPool_UnfairSemaphoreSpinLimit=0`, an undocumented runtime knob, 0.34 / 0.32 / 0.30 ms; p99 5.3–6.4 ms with and without the knob.
- **Not a defect:** the spinning exists to cut wake-up latency, which this steady load did not stress; bursts and MySQL were not checked.

### Puma threads above the pool size

- **Setup:** Ruby Puma, PostgreSQL, 200 clients and 2000 req/s ([section 1b](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/results/2026-10/tables.md)).
- **What:** the harness gives each Puma worker 3 database connections (24 per stack), and Puma's default on MRI is 5 threads, so two threads wait for a connection.
- **Measured:** p99 1424 ms with 5 threads and 44 ms with 3 at 200 clients; stack CPU 0.462 → 0.403 ms. At 2000 req/s the two are equal (p99 6.1 and 5.9 ms). The tables use 3 threads.
- **Fix:** as many threads per worker as database connections per worker. Rails' generated database configuration already ties both to `RAILS_MAX_THREADS`; this applies to Puma without it.

### tokio-postgres query prepares every statement

- **Setup:** Rust hyper with tokio-postgres 0.7 through deadpool-postgres, PostgreSQL, 2000 req/s.
- **What:** `Client::query(&str, …)` prepares the statement, executes it and closes it: 40 distinct statement names for 10 requests in the [wire check](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/results/2026-10/wire-check.txt). The Rust stack has the lowest CPU of all (0.27 ms) and costs PostgreSQL 1.44 ms per request, against 0.52 ms for Go and Java.
- **Fix, not measured:** deadpool-postgres, the pool this implementation uses, offers [`prepare_cached`](https://docs.rs/deadpool-postgres/0.14.2/deadpool_postgres/struct.ClientWrapper.html#method.prepare_cached); tokio-postgres' [`query_typed`](https://docs.rs/tokio-postgres/0.7.18/tokio_postgres/struct.Client.html#method.query_typed) sends an unnamed statement with explicit types in one exchange; sqlx caches statements by default.

### Go database/sql with go-sql-driver prepares every statement on MySQL

- **Setup:** Go `net/http` with `database/sql` and go-sql-driver, MySQL 8.4.11, 2000 req/s.
- **What:** go-sql-driver does not interpolate parameters by default, so `database/sql` prepares, executes and closes every parameterized statement: 40 of each for 10 requests in the wire check. Go costs MySQL 1.35 ms per request, the most of the twelve, and its stack CPU is 0.56 ms against 0.40 ms with pgx on PostgreSQL.
- **Fix, not measured:** [`interpolateParams=true`](https://github.com/go-sql-driver/mysql#interpolateparams) in the DSN, which sends one text query per statement like most MySQL drivers here.

### mysql_async: the pool's session reset drops prepared statements

- **Setup:** Rust hyper with mysql_async 0.37, MySQL 8.4.11, 2000 req/s.
- **What:** mysql_async caches prepared statements per connection, but its pool resets the session when a connection is returned, and MySQL frees the session's prepared statements on reset: 40 prepares for 10 requests in the wire check. This is how MySQL's reset works, not a bug in the driver. Rust costs MySQL 1.32 ms per request, against 1.12–1.27 ms for the text-query drivers.
- **Fix, not measured:** `PoolOpts::with_reset_connection(false)` keeps the statements, but session state — variables, temporary tables, an open transaction after an error — then passes to the next user of the connection.

## Open questions

### Swoole on PostgreSQL at 4000 req/s

- **Setup:** PHP Swoole 6.2.3 with coroutine hooks and pdo_pgsql, 8 workers with 3 connections each, PostgreSQL, fixed 4000 req/s over 48 connections ([section 1a](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/results/2026-10/tables.md)).
- **What:** Swoole did not sustain 4000 req/s in 2 of its 5 attempts, and its accepted median p99 is 78 ms against 3.6–10.4 ms for the other stacks; one accepted attempt had a p99 of 1.7 s.
- **Not explained yet:** on MySQL the same pool sustains 4000 req/s with a p99 of 7.6 ms. On PostgreSQL pdo_pgsql's three exchanges per statement hold each connection longer, which may queue requests at the pool; not checked. In a separate run inside one cloud VM with netem on loopback (0.54 ms round trip) and 5000 requests waiting 1 s, a pool of 12 connections per worker instead of 3 raised Swoole from 2567 to 4741 req/s, so a queue at the pool can limit it; that run is not in the repository.

### RoadRunner memory per worker

- **Setup:** the waiting series, PostgreSQL, a PHP worker per waiting request, RoadRunner up to its limit of 500 workers ([section 3](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/results/2026-10/tables.md)).
- **What:** 11.5 GiB per 1000 waiting requests, about 11.8 MiB per worker, against 1.2 MiB per FPM child; both are a PHP process per request.
- **Not explained yet:** FPM forks its children from one master, and they can share the master's memory — OPcache included — copy-on-write, while RoadRunner starts every worker as a separate PHP process with its own OPcache memory and heap. A breakdown of one worker's memory (`/proc/<pid>/smaps`) is the next check.

## What this means for PHP

- On PostgreSQL the four PHP stacks are in the expensive half of the table. A quarter to a half of FPM's gap to Go at saturation comes from pdo_pgsql's default: another PDO mode or PgBouncer takes FPM from 2.60 to 1.91–2.21 ms, against 1.09 ms for Go.
- On MySQL, Swoole and FrankenPHP have the lowest totals of all twelve stacks, and FrankenPHP pays for a lock in mysqlnd that can be switched off today; a patch to remove it is proposed for php-src.
- FPM needs 1.1 GiB per 1000 waiting requests; RoadRunner, also a process per request, about ten times that, for a reason not yet confirmed.
- Swoole and FrankenPHP worker mode are the cheapest PHP stacks on both databases; RoadRunner, which also keeps the application in memory, spends more in the stack than either.

## What to check in your own service

The measurement is about defaults, but the lesson is practical: find out what your driver does with each statement — from its documentation and code first.

- **PostgreSQL:** a plain statement log does not show it, because with the extended protocol PostgreSQL logs a statement when it is executed, not when it is parsed. Logging the protocol stages (`log_parser_stats`, or `log_min_duration_statement = 0` with `log_duration`) or `pg_stat_statements` with planning statistics on (`pg_stat_statements.track_planning`, off by default) shows whether the same query is parsed and planned again on every request.
- **MySQL:** the server counts prepares and closes. If `Com_stmt_prepare` in `SHOW GLOBAL STATUS` grows as fast as `Com_stmt_execute`, every statement is prepared again; if `Com_stmt_close` grows with them, the driver prepares and closes each one.
- **PHP with MySQL on a threaded server** (FrankenPHP, Apache with a threaded MPM, ext/parallel): if `php -i` shows `Thread Safety => enabled`, set `mysqlnd.collect_statistics=0` unless something reads the statistics.

The drivers here offer two different remedies. Some keep statements prepared on the server: Npgsql's `Max Auto Prepare`, deadpool-postgres' `prepare_cached`, named statements in node-postgres, PgBouncer with `max_prepared_statements` in front of PDO. Others cut the exchanges per statement instead, with the database still parsing each one: PDO's emulated prepares or `ATTR_DISABLE_PREPARES`, tokio-postgres' `query_typed`, and go-sql-driver's `interpolateParams` on MySQL. What each does to this API is what the next stage measures, on every stack together.

## What this does not show

- **Languages in general.** One read-only API, no frameworks, no writes, caches, logging or business logic. The "stack" CPU includes the HTTP server, the driver and the JSON encoder, not only the VM.
- **The cloud.** One desktop machine with boost on, everything over loopback. In a deployment of several VMs, network interrupts and wake-ups across vCPUs add CPU per request, more for some models than for others; a cloud run is planned as a separate publication.
- **Tuned stacks.** Every driver is on its default on purpose. Turning on statement caching everywhere would likely close most of the database gap on PostgreSQL; that is the next stage, measured for all stacks at once.
- **Independent review.** I wrote the implementations with an AI assistant and checked them for equivalent responses; as of this run they have not been reviewed by each language's community. I contribute to PHP, which is why the rules are written down before the numbers.

## Next

Stage 1 is the baseline: vendor defaults under equal rules. The next stages change one thing at a time against it — driver settings, then tuning, then frameworks (Laravel, Symfony, Spring, ASP.NET, NestJS, FastAPI, Rails, …), then the cloud.

Some questions I would like people who run these stacks to answer, in [the repository's issues](https://github.com/ArtUkrainskiy/web-request-cost/issues):

- Rust: does a typical service call tokio-postgres' `query(&str)`, or `query_typed`, `prepare_cached` or sqlx?
- .NET: is the thread pool's spinning on a lightly loaded server expected at this size, and do production services change it?
- Node: do services name their node-postgres statements, or leave them unnamed as the default does?
- Go with MySQL: is `interpolateParams` the usual setting?
- Swoole: is a pool of 3 connections per worker under pdo_pgsql a fair default, or do services use `Swoole\Coroutine\PostgreSQL` or larger pools?

If the implementation or configuration of a stack looks wrong to you, please open an issue too: the results are re-published whenever a mistake is found.
