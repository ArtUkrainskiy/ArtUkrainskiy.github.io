---
title: "12 web stacks on vendor defaults: the PostgreSQL driver matters more than the language"
description: "The same JSON API in PHP, Go, Node, Rust, Java, .NET, Python and Ruby, every stack on its vendors' defaults, measured on one machine: CPU per request, memory per waiting request, and why the driver's prepared-statement default matters more than the runtime."
pubDatetime: 2026-10-17T21:00:00Z
draft: false
tags:
  - performance
  - php
  - benchmarks
---

Most comparisons of web stacks answer "which one serves more requests per second". I wanted a different answer: how much CPU and memory one ordinary API request costs, on each stack as its vendors ship it, under the same rules for everyone. I wrote the same small JSON API twelve times — PHP (four runtimes), Go, Node (two servers), Rust, Java, .NET, Python and Ruby — and measured all of them on one machine. The result that surprised me most is not about languages at all: on PostgreSQL, whether the database driver keeps prepared statements by default moves the cost more than the runtime does.

Everything below comes from the repository [web-request-cost](https://github.com/ArtUkrainskiy/web-request-cost/tree/afd7ea6ee4f2f10069bd029e0c29a705c034861c) at commit `afd7ea6`: the code, the rules, 700 raw records and the script that turns them into [the tables](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/results/2026-10/tables.md).

## Contents

## What was measured

- **The API** ([spec](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/spec/spec.md)): a token lookup in the database, then a page of 20 posts with authors, tags and comment counts, or one post with its comments. Four SQL statements on the main path, the Symfony Demo data ×100 in PostgreSQL 17 or MySQL 8.4. Every implementation must return equivalent JSON content, checked by hashing canonicalized responses (keys sorted, escaping normalized) before measuring.
- **The stacks:** PHP-FPM with nginx, FrankenPHP, RoadRunner and Swoole; Go `net/http`; Node `node:http` and Fastify; Rust hyper; Java Jetty 12 on virtual threads; .NET 10 Kestrel; Python uvicorn; Ruby Puma. PHP has four because they are four execution models (a process per request, a thread per request, a pool of exec'd workers, coroutines); other languages and runtimes are welcome as contributions. Each stack uses a widely used low-level driver of its ecosystem with its plain documented call — the choice of driver is part of the result. Minimal applications without full application frameworks or ORMs (Fastify, a Node HTTP framework, is the one exception); frameworks are the next stage.
- **The rules** ([docs/rules.md](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/docs/rules.md)): runtimes and servers with the production setup their own documentation gives (php.ini-production and OPcache, `uvicorn[standard]`, the `dotnet new web` host, …), database drivers on their defaults, and the same sizing for everyone: process counts per CPU, 24 database connections per stack (PHP workers hold one each: FPM 32, FrankenPHP and RoadRunner 16), one connection per request. The few departures from a default are listed there with the reason for each.
- **The machine:** stack on 4 cores / 8 threads of an AMD Ryzen 9 5950X, databases, load generator and an upstream stub on other cores of the same host, over loopback.
- **The metric:** cgroup CPU time of the stack's containers per request served, and separately the CPU time of the database server per request. At least three passes of every series; the checks in the .NET section below are one pass each.
- **When and what:** measured on 16–17 October 2026 with PHP 8.5.11, Go 1.27.2, Node 24.22, Rust 1.99, Java 25, .NET 10.0.13, Python 3.14.8, Ruby 4.0.7, PostgreSQL 17.11 and MySQL 8.4.11. The load generator for the fixed rates is wrk2, which corrects for coordinated omission.

## CPU per request at the same load

CPU per request is CPU time summed across all cores of the stack's containers (or of the database server), divided by the requests served — a cost, not a latency. At a fixed 2000 req/s over 48 connections, without waiting, on PostgreSQL ([section 1a](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/results/2026-10/tables.md)), sorted by stack + database:

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

Two things stand out. The stacks themselves are close: 0.27–0.51 ms of CPU per request, a factor of about two between the cheapest and the most expensive, with .NET as the exception (more on that below). And the database column splits the table in two: three stacks cost PostgreSQL about half a millisecond per request, all the others 1.2–1.5 ms. Latency is unremarkable at this load: p99 at 4000 req/s is 3.6–10.4 ms for every stack except Swoole (78 ms; below).

## The driver's default

The three cheap rows are exactly the three whose drivers keep prepared statements on each connection by default. Go's [pgx](https://pkg.go.dev/github.com/jackc/pgx/v5) caches them, Java's PgJDBC makes a statement server-side prepared after five uses on a connection, Python's asyncpg caches them too. The others send each statement in a form that PostgreSQL has to parse and plan every time — node-postgres and Ruby's `pg` as unnamed statements, Rust's tokio-postgres and PHP's pdo_pgsql by preparing, executing and closing every statement, Npgsql as unnamed statements plus a session reset when the connection goes back to the pool. What each driver does is in the [driver table of the rules](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/docs/rules.md#database-statements-the-drivers-defaults): the executes are counted in the database logs, the prepare and close pattern follows from each driver's code.

So with every stack on its defaults, the database work per request differs by a factor of two to three, and that difference — 0.65–0.99 ms — is larger than the whole CPU cost of most runtimes. Rust has the cheapest stack and a total in the expensive half of the table; the cause is tokio-postgres' `query(&str)`, which prepares and closes every statement — a different Rust library such as sqlx, or `prepare_cached`, caches them. That is why this compares drivers and the calls chosen more than languages. Switching statement caching on for the other drivers, to show how much of the gap it closes, is the next stage; this one only shows where the defaults put each stack.

On MySQL the order changes. Most MySQL drivers send one text query per statement by default, and stack + database is lowest for Swoole (1.35 ms) and FrankenPHP (1.48 ms); Go is last but one (1.91 ms), because go-sql-driver prepares, executes and closes every statement unless `interpolateParams` is on. With the drivers mostly alike there (database CPU 1.12–1.35 ms for every stack), differences on the application side — server, driver, data conversion, serialization — become more visible: Swoole spends 0.19 ms per request.

Swoole, the cheapest PHP stack, is also the one with a problem: on PostgreSQL it did not sustain 4000 req/s in 2 of its 5 attempts, and one of the accepted attempts had a p99 of 1.7 s, probably because its pool of 3 connections per worker queues requests at that rate. It is also not the usual way PHP is deployed; FPM is.

For PHP-FPM on PostgreSQL I measured four statement configurations — three PDO modes and PgBouncer in front of native prepares ([section 6](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/results/2026-10/tables.md), at C = 50, that is 48 connections, with the database saturated, so the absolute numbers are higher than at 2000 req/s):

| PDO mode                                                      | stack + database per request |
| ------------------------------------------------------------- | ---------------------------: |
| native prepares, direct (pdo_pgsql's default)                 |                      2.60 ms |
| `PDO::ATTR_EMULATE_PREPARES`                                  |                      2.13 ms |
| `Pdo\Pgsql::ATTR_DISABLE_PREPARES`                            |                      2.21 ms |
| native prepares through PgBouncer (`max_prepared_statements`) |                      1.91 ms |

At this workload the default is the most expensive of the four. PgBouncer is the cheapest in total because it keeps the statements prepared on its server connections across requests, while pdo_pgsql closes every statement after use. Its own CPU counts as the stack's (1.09 ms against 0.59 ms directly), but it reduces database CPU enough to lower the combined cost by about 27% despite the higher CPU on the application side. Emulated prepares and `ATTR_DISABLE_PREPARES` save something else: they send each statement in one exchange instead of three, while PostgreSQL still parses every statement.

## .NET: the CPU of waiting for work

.NET has the highest CPU per request in the table, 0.83 ms, and that looked wrong. Two things pointed at the cause. Its CPU per request falls as the load grows: 0.97 ms at 1000 req/s, 0.83 at 2000, 0.70 at 4000. And the order of the rates does not matter: running them in descending order on one start gives the same numbers (0.965 / 0.817 / 0.693 ms), so the order of the warm-up does not explain it.

A runtime that spends less per request when it has more requests is paying for something while it is idle. The .NET thread pool spins for a while before a worker thread goes to sleep, so that new work does not have to wake it. With that spinning switched off (`DOTNET_ThreadPool_UnfairSemaphoreSpinLimit=0`, not a default), the same stack spends 0.34 / 0.32 / 0.30 ms per request at the three rates — the level of Java and Go ([section 1b](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/results/2026-10/tables.md)). Latency did not change (p99 5.3–6.4 ms in both runs). The published number keeps the default, because that is what stage 1 measures; the point is what it consists of. Other stacks also spend less per request at higher rates — Node 0.43 → 0.34 ms, Go 0.40 → 0.34, FrankenPHP 0.43 → 0.39 — but .NET is the one where the effect is large enough to change its rank. On a lightly loaded server most of .NET's CPU here is spent waiting for work, and that cost shrinks as the load grows.

## Waiting requests and memory

The third series makes every request wait on another service, 0.1 s or 1 s, as if it called a slow API. Here the execution model matters. For blocking models — PHP-FPM, FrankenPHP, RoadRunner, Puma's threads — the harness provisions a PHP worker per waiting request (RoadRunner accepts at most 500) and about two Puma threads per waiting request, so the series shows what each model needs to hold C requests that wait, not how a fixed production pool behaves.

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

Per worker that is about 11.8 MiB for RoadRunner against 1.2 MiB for an FPM child (RoadRunner measured up to its limit of 500 workers). Both are a PHP process per request; the gap most likely comes from how the processes start: FPM forks its children from one master, and they share the master's memory — OPcache included — copy-on-write, while RoadRunner starts every worker as a separate PHP process with its own OPcache memory and heap.

These are slopes of one series, not the size of one request, and they do not carry over to other loads: Node's 0.90 GiB is its heap growing up to 1000 concurrent requests, after which it adds only 0.14 GiB per 1000; Node at about 1000 req/s with a 0.1 s wait uses twice what the slope predicts; and Java's slope varies between passes from 0.39 to 0.76 GiB. What is stable is the order at the ends: RoadRunner far above everything else in every pass, the coroutine, goroutine, async and Rust stacks at about a tenth of a GiB or less.

## What it costs in money

The repository turns these numbers into dollars with an explicit model ([section 8](https://github.com/ArtUkrainskiy/web-request-cost/blob/afd7ea6ee4f2f10069bd029e0c29a705c034861c/results/2026-10/tables.md) works through it): 1000 req/s with a 0.1 s wait, vCPU at a 60% target utilisation, AWS on-demand prices decomposed into a price per vCPU ($26.83/month) and per GiB ($2.66/month), with the CPU per request of the run with a 0.1 s wait (Java 0.46 ms in the stack and 0.71 ms in the database, not the 2000 req/s figures above). With the database's CPU added, Go, Java and Python come to $49–55 a month and every other stack to $79–105. The stacks alone cost $15–46.

That is an amortised resource price, not a bill: fractional vCPUs, no minimum instance, no high availability, only the database's CPU and not its memory or storage. Its main use is to show the proportions — the database is the larger part for most stacks — and that at this scale the differences are tens of dollars a month, small next to the cost of the team that writes the service.

## What this does not show

- **Languages in general.** One read-only API, no frameworks, no writes, caches, logging or business logic. The "stack" CPU includes the HTTP server, the driver and the JSON encoder, not only the VM.
- **The cloud.** One desktop machine with boost on, everything over loopback. In a deployment of several VMs, network interrupts and wake-ups across vCPUs add CPU per request, more for some models than for others; a cloud run is planned as a separate publication.
- **Tuned stacks.** Every driver is on its default on purpose. Turning on statement caching everywhere would likely close most of the database gap; that is the next stage, measured for all stacks at once.
- **Independent review.** I wrote the implementations with an AI assistant and checked them for identical responses; as of this run they have not been reviewed by each language's community. I contribute to PHP, which is why the rules are written down before the numbers.

## What to check in your own service

The measurement is about defaults, but the lesson is practical: find out what your PostgreSQL driver does with each statement — from its documentation and code first. A plain statement log does not show it: with the extended protocol PostgreSQL logs a statement when it is executed, not when it is parsed. Logging the protocol stages (`log_parser_stats`, or `log_min_duration_statement = 0` with `log_duration`) or `pg_stat_statements` with planning statistics on (`pg_stat_statements.track_planning`, off by default) shows whether the same query is parsed and planned again on every request.

The drivers here offer two different remedies. Some keep statements prepared on the server: Npgsql's `Max Auto Prepare`, tokio-postgres' `prepare_cached`, named statements in node-postgres, PgBouncer with `max_prepared_statements` in front of PDO. Others cut the exchanges per statement instead, with PostgreSQL still parsing each one: PDO's emulated prepares or `ATTR_DISABLE_PREPARES`, and go-sql-driver's `interpolateParams` on MySQL. What each does to this API is what the next stage measures, on every stack together.

## Next

Stage 1 is the baseline: vendor defaults under equal rules. The next stages change one thing at a time against it — driver settings, then tuning, then frameworks (Laravel, Symfony, Spring, ASP.NET, NestJS, FastAPI, Rails, …), then the cloud. If you run one of these stacks in production and the implementation or its configuration looks wrong to you, please [open an issue](https://github.com/ArtUkrainskiy/web-request-cost/issues): the results are re-published whenever a mistake is found.
