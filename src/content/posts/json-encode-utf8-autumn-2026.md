---
title: "json_encode() in php-src, autumn 2026: where the time goes and what is on the table"
description: "Five open pull requests, four compilers and two CPUs: what each change to json_encode()'s string escaping actually does, where it helps, where it hurts, and what is likely to land."
pubDatetime: 2026-10-12T22:45:00Z
draft: false
tags:
  - php-src
  - performance
  - json
---

`json_encode()` is in almost every PHP request that answers an API call. In autumn 2026 there are five open pull requests in php-src that try to make its string escaping faster, plus one of mine. I measured all of them on the same master, with four compilers and two CPUs, and checked that every one of them produces exactly the same bytes as master. This post is the map: what each change does, where it wins, where it loses, and why the answer depends on the compiler more than I expected.

## Contents

## Where json_encode() spends its time

Almost all of the work for strings happens in one function, `php_json_escape_string()`. On a typical API response, 1,000 records of 10 short fields, it takes about half of the instructions of the whole `json_encode()` call. Three things in it cost the most on master:

- **The scan for bytes that need escaping.** Every byte is checked against a 256-bit table (`ZEND_BIT_TEST`), about 11 instructions per byte with GCC 13.
- **Non-ASCII characters.** Each one goes through `php_next_utf8_char()` in `ext/standard/html.c`, which calls the generic decoder `get_next_char()` for 14 charsets. That is about 43 instructions per character (callgrind), before the character is even escaped.
- **The scan position lives in memory.** The address of the loop's position variable is passed to that decoder, so the compiler keeps the variable on the stack. With GCC the loop over plain bytes stores it and loads it back on every byte, and the next byte's address waits for that load.

## How I measured

- Release builds from commits (`-O2`), each change merged onto the same master.
- **Compilers:** GCC 13.3, GCC 14.2 and clang 18.1 / 20.1 on an i7-13700H (one P-core pinned); GCC 15.2 and clang 21.1 on a Ryzen 9 5950X.
- **Numbers:** cycles and instructions per `json_encode()` call from `perf stat`, N calls minus the same process with 0 calls, median of alternating runs. Cycles rather than nanoseconds, because a laptop under load changes its clock.
- **Correctness:** output and `json_last_error()` compared with master on every pair of bytes, every three-byte sequence with an E0..EF lead, every byte value at every position of short strings, literal keys, and a million random strings, under up to 11 flag sets. Every change in this post passed. Nothing below is about bugs; it is all about speed.

Everything is in [php-src-bench](https://github.com/ArtUkrainskiy/php-src-bench/tree/main/reports/json-encode-utf8-inline), with the commands to reproduce it.

## The open pull requests

| PR                                                  | What it does                                  | State in mid-October                                                             |
| --------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------- |
| [#23675](https://github.com/php/php-src/pull/23675) | SSE2/NEON scan of 16 bytes at a time          | my measurements posted on 13 October, no maintainer review yet                   |
| [#23682](https://github.com/php/php-src/pull/23682) | 256-byte lookup table instead of the bit test | reviewed, no activity since 18 September                                         |
| [#17734](https://github.com/php/php-src/pull/17734) | own UTF-8 decoder and SIMD path               | the maintainer asked to split it; the author left it for someone else to pick up |
| [#22932](https://github.com/php/php-src/pull/22932) | SIMD scan of the clean prefix only            | open                                                                             |
| [#22492](https://github.com/php/php-src/pull/22492) | fast path for keys                            | no activity since July                                                           |

### SIMD (#23675, #22932, #17734)

On long ASCII all three are about 5× faster than master (0.19–0.22 of master's cycles). On text with escapes spread through it #23675 keeps the vector loop going after each escape (HTML 0.21), while #22932 only skips the prefix before the first special byte and then runs at master's speed.

The cost is non-ASCII text with default flags. There every byte of every character needs escaping, so the vector path never skips anything and each character also pays the walk over the block's bitmask. With GCC that makes Cyrillic and CJK 4–18% slower with #23675 (and 17–29% with #17734, measured with GCC 13). With clang, #23675 is at 0.89–0.98 on the same inputs: not because its loop is better there, but because clang's master is worse, as the next section shows.

### The lookup table (#23682)

Replacing the bit test with a 256-byte table removes instructions with every compiler: 25–33% fewer on ASCII. Whether that becomes time depends on the compiler:

| cycles vs master | GCC 13 | GCC 14 | clang 18 | clang 20 |
| ---------------- | -----: | -----: | -------: | -------: |
| ASCII, 4 KiB     |   0.79 |   0.82 |     1.00 |     1.02 |
| HTML             |   0.81 |   0.87 |     1.07 |     1.00 |
| Cyrillic         |   1.19 |   1.21 |     0.96 |     1.00 |

With GCC, Cyrillic gets slower at fewer instructions: branch mispredictions on that input go up about 2.5 times.

### Inline UTF-8 decoding ([#24283](https://github.com/php/php-src/pull/24283), mine)

`php_next_utf8_char_inline()` decodes ASCII and valid two- and three-byte UTF-8 at the call site and leaves everything else, including every invalid sequence, to the existing `php_next_utf8_char()`. The shortcut is exact: C2..DF followed by a continuation byte is always a valid shortest form, and for three bytes it checks the same two conditions as the old code (not overlong, not a surrogate). With four compilers on the Intel machine and two on a Ryzen 9 5950X, Cyrillic takes 0.73–0.80 of master's cycles and CJK 0.70–0.78, and ASCII runs the same instructions as before.

Two caveats. With GCC 13 and 14 on the Intel machine, URLs and ASCII with an occasional escaped é are 10–14% slower in cycles, from the layout GCC picks for the path of special characters; clang and the AMD machine show nothing, and the scan split described below removes it. An input with an é exactly every 31 bytes looked worse at first, but that was the branch predictor learning the period: with é at random positions the change is faster everywhere. And my other PR, [#24145](https://github.com/php/php-src/pull/24145) for `htmlspecialchars()`, makes `get_next_char()` always inline, which already takes Cyrillic to 0.82 on its own; on top of it the inline decoder still removes 14–20% of the instructions on non-ASCII text, but with GCC that shows mostly on CJK and on `JSON_UNESCAPED_UNICODE`.

## The compiler is part of the result

The most instructive part of this work was a change that looked obviously right and was not.

Keeping the scan position in a register instead of on the stack, by not passing its address to the decoder, made HTML 0.57–0.60 and a quote every 16 bytes 0.44 of master's cycles with GCC 13 and 14. With clang the same change did nothing for ASCII, because clang already kept the counter in a register and only stored a copy. With clang 20, the compiler in php-src's CI, it made HTML 17% and a newline every 40 bytes 42% slower: the loop ended up with two checks for the end of the string per byte.

Fixing that for clang by reshaping the loop broke Cyrillic for clang through branch mispredictions, and fixing that broke ASCII again. The way out was to stop fighting the compiler inside one large function:

- **Move the scan into a small function** that returns the length of the plain run. The main loop appends the run and handles one special character. The scan loop no longer depends on the code around it, and the position variable disappears.
- **Use the lookup table** in that scan. With a bit test, GCC 13 compiled the check to `shr %cl` instead of `bt` in the new context, whatever form I wrote it in. A table is one load and a compare on every compiler.

Together, with the inline decoder, cycles relative to master:

|                           | GCC 13 | GCC 14 | clang 18 | clang 20 |
| ------------------------- | -----: | -----: | -------: | -------: |
| ASCII, 4 KiB              |   0.59 |   0.54 |     0.53 |     0.53 |
| Cyrillic                  |   0.65 |   0.70 |     0.66 |     0.61 |
| CJK                       |   0.78 |   0.73 |     0.59 |     0.58 |
| a newline every 40 bytes  |   0.39 |   0.31 |     0.67 |     0.63 |
| 1,000 arrays of 10 fields |   0.89 |   0.92 |     0.97 |     0.91 |
| worst of 14 inputs        |   1.00 |   1.03 |     1.01 |     1.05 |

So the table from #23682 is not just a smaller win: it is the piece that makes the result independent of the compiler, once the scan is a loop of its own.

The same thing showed up from the other side in #23675. Counting instructions per non-ASCII character in `php_json_escape_string()` itself, master runs 74 with GCC and 93 with clang: clang stores seven registers to the stack before every call to `php_next_utf8_char()` and loads them back after it. #23675 adds about 9 instructions per character for its bitmask walk with both compilers, but its new loop also happens to stop clang from spilling, so with clang it comes out ahead and with GCC behind. Neither result says much about the SIMD code itself.

Lessons I am keeping:

- Measure with the compiler the project's CI uses and with the one the distributions ship, not only the one on your machine.
- Equal instruction counts with different cycles mean placement or prediction; check the machine code and the branch counters before calling it an effect of the change.
- A hot loop inside a big function is at the mercy of everything else in that function.

## Next door

- **`htmlspecialchars()`.** [#23957](https://github.com/php/php-src/pull/23957) returns the input when nothing needs encoding and is approved; [#24145](https://github.com/php/php-src/pull/24145) speeds up strings that do need encoding. They touch the same function; the plan agreed in #23957 is to land it first and rebase #24145 on top. On top of #23957, #24145 is still 1.8–2.8× faster on English, HTML, Markdown and JavaScript.
- **`json_decode()`.** Text escaped as `\uXXXX`, which is what `json_encode()` produces by default, costs about 207 instructions per escaped character: the scanner matches every escape twice. Converting the hex digits without branches already saves 12% of the cycles there.
- **Keys.** Keys repeat from record to record and are often interned (literal keys, declared properties, mysqlnd column names), so a per-call cache of keys that need no escaping saves about 10% on 1,000 records. It does not help SQLite or PostgreSQL rows, whose column names are not interned.

## What is likely to happen

- The inline UTF-8 decoder is a small, self-contained change with a clear gain on non-ASCII text on every compiler I tried, and it does not change any public symbol: [#24283](https://github.com/php/php-src/pull/24283).
- The scan split depends on a lookup table. The right table is the one in #23682, so the scan split waits for it, and my review there includes these numbers.
- The SIMD scan of #23675 is the biggest single win for ASCII. With #24283 merged on top, nothing non-ASCII is slower than master any more: Cyrillic takes 0.85–0.87 of master's cycles with GCC and 0.66–0.68 with clang.
- `htmlspecialchars()` follows the plan agreed in #23957.

Everything above is reproducible from [the report](https://github.com/ArtUkrainskiy/php-src-bench/tree/main/reports/json-encode-utf8-inline). If you maintain an application that sends a lot of non-ASCII JSON, I would like to hear how these numbers look on your data.
