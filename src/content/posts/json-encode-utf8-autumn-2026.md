---
title: "json_encode() in php-src, autumn 2026: where the time goes and what the open pull requests change"
description: "Six open pull requests to json_encode()'s string escaping, one of them mine, measured with up to four compilers on two CPUs: where each one helps, where it hurts, and what each needs before it can land."
pubDatetime: 2026-10-12T22:45:00Z
modDatetime: 2026-10-22T12:00:00Z
draft: false
tags:
  - php-src
  - performance
  - json
---

`json_encode()` is in almost every PHP request that answers an API call. In autumn 2026 there are six open pull requests in php-src that try to make its string escaping faster: five by other people and one of mine. I measured them against php-src master and checked that each one produces exactly the same bytes as master. The answer depends on the compiler more than I expected.

In short:

- **For applications:** none of these is merged, so no released PHP has them yet. The output does not change, so there is nothing to change in your code.
- **Long ASCII strings:** the three SIMD pull requests take 78–81% fewer cycles than master, about 5× faster. Two of them were measured with GCC 13 only. With GCC, #23675 makes Cyrillic and CJK text 4–18% slower, and #17734 17–29%.
- **Non-ASCII text:** my [#24283](https://github.com/php/php-src/pull/24283) takes 9–32% fewer cycles on Cyrillic, CJK and emoji, on all six compilers. It is the only one I also measured on the AMD machine. With GCC on the Intel machine some other inputs take 7–20% more cycles.
- **The compiler:** an experiment of mine, not one of the six PRs, took 43% fewer cycles with GCC and made the same input 17% slower with clang 20. Distributions and the official Docker images build PHP with GCC, and php-src's CI builds with both. Numbers from one compiler are not enough for changes like these.

All numbers below are CPU cycles per `json_encode()` call compared with master. Negative means fewer cycles, so faster.

## Contents

## Where json_encode() spends its time

Almost all of the work for strings happens in one function, [`php_json_escape_string()`](https://github.com/php/php-src/blob/bd6c637d0710521ad30370d13f3f47be34ccda0b/ext/json/json_encoder.c#L350). On a typical API response, 1,000 records of 10 short fields, it takes about half of the instructions of the whole `json_encode()` call.

By default `json_encode()` writes every non-ASCII character as a `\uXXXX` escape. Only `JSON_UNESCAPED_UNICODE` turns that off. So with default flags every character of Cyrillic or CJK text is decoded from UTF-8 and escaped, and that is why non-ASCII text is the slow case.

Three things in the function cost the most on master:

- **The scan for bytes that need escaping.** Every byte is checked against a [256-bit table](https://github.com/php/php-src/blob/bd6c637d0710521ad30370d13f3f47be34ccda0b/ext/json/json_encoder.c#L387-L392) (`ZEND_BIT_TEST`). That is about 11 instructions per byte with GCC 13.
- **Decoding non-ASCII characters.** Each one goes through [`php_next_utf8_char()`](https://github.com/php/php-src/blob/bd6c637d0710521ad30370d13f3f47be34ccda0b/ext/standard/html.c#L349-L356) in `ext/standard/html.c`. It calls [`get_next_char()`](https://github.com/php/php-src/blob/bd6c637d0710521ad30370d13f3f47be34ccda0b/ext/standard/html.c#L87), a generic decoder for 14 charsets ([its UTF-8 case](https://github.com/php/php-src/blob/bd6c637d0710521ad30370d13f3f47be34ccda0b/ext/standard/html.c#L104)). That is about 43 instructions per character, counted with callgrind, before the character is even escaped.
- **The scan position lives in memory.** The loop passes the address of its position variable to that decoder, so the compiler keeps the variable on the stack. With GCC the loop over plain bytes stores it and loads it back on every byte, and reading the next byte waits for that load.

## How I measured

- **Builds:** release builds with `-O2 -falign-functions=64 -falign-loops=32` of each pull request merged onto master. Three of them (#24283, #23682, #23675) were measured on master `bd6c637d071` with the four compilers on Intel. The other three (#17734, #22932, #22492) were measured earlier, on master `80d2b997192`, with GCC 13 only.
- **Compilers:** GCC 13.3, GCC 14.2, clang 18.1 and clang 20.1 on an Intel i7-13700H, pinned to one P-core. GCC 15.2 and clang 21.1 on an AMD Ryzen 9 5950X, for #24283 only. The [official Docker images](https://github.com/docker-library/php/blob/master/8.5/trixie/cli/Dockerfile) build PHP with GCC.
- **Numbers:** cycles and instructions per call from `perf stat`. I run N calls and subtract the same process with 0 calls. Runs of master and the change alternate, and the tables show the median. For #24283 that is 5 runs per row on the Intel machine and 15 on AMD, and master against itself stays within 2%. I count cycles rather than nanoseconds because a laptop changes its clock under load.
- **Correctness:** I compared the output and `json_last_error()` with master on every pair of bytes, every three-byte sequence with an E0..EF lead, every byte value at every position of short strings, and 200,000 to 1,000,000 random strings, under up to 11 flag sets. For #24283 also on every four-byte sequence with an F0..FF lead. Every change passed, so the rest of the post is only about speed.

Inputs are 4 KiB strings unless noted, built from a few repeated words: `привет мир текст` for Cyrillic, `漢字 中文 日本語` for CJK, four emoji for emoji. The [benchmark script](https://github.com/ArtUkrainskiy/php-src-bench/blob/main/reports/json-encode-utf8-inline/cases.php) lists every input. For scale, this is what one call costs on master, in cycles (median of the master runs of the #24283 series):

| input                     |  GCC 13 |  GCC 14 | clang 18 | clang 20 |
| ------------------------- | ------: | ------: | -------: | -------: |
| ASCII, 4 KiB              |   8,560 |   8,010 |    8,520 |    8,340 |
| HTML                      |  29,610 |  28,140 |   16,740 |   17,540 |
| Cyrillic                  |  38,600 |  36,140 |   45,080 |   43,680 |
| CJK                       |  25,230 |  25,260 |   31,540 |   29,660 |
| 1,000 records of 10 fields | 916,000 | 850,000 |  917,000 |  888,000 |

Master itself already differs by compiler: GCC is slower on HTML because of the scan position kept in memory, and clang is slower on Cyrillic and CJK, for the reason [below](#the-compiler-is-part-of-the-result).

The commits, the raw data and how to reproduce it are listed [at the end](#commits-and-data).

## The open pull requests

| PR | What it does | State on 22 October 2026 | Main open point |
| --- | --- | --- | --- |
| [#23675](https://github.com/php/php-src/pull/23675) | SSE2/NEON scan of 16 bytes at a time | no maintainer review yet | the GCC slowdown on non-ASCII text |
| [#23682](https://github.com/php/php-src/pull/23682) | 256-byte lookup table instead of the bit test | reviewed in September, changes made, waiting for re-review | the GCC slowdown on Cyrillic |
| [#22932](https://github.com/php/php-src/pull/22932) | SIMD scan of the clean prefix only | no activity from the author since July | no maintainer review |
| [#17734](https://github.com/php/php-src/pull/17734) | own UTF-8 decoder and SIMD path | the maintainer asked to split it; the author left it for someone else | a new owner and a split |
| [#22492](https://github.com/php/php-src/pull/22492) | fast path for keys | no activity since July | a reviewer |
| [#24283](https://github.com/php/php-src/pull/24283) (mine) | UTF-8 decoding inline in the caller | reviewed by a contributor, waiting for a maintainer | where the inline decoder's header lives; the GCC slowdown on some ASCII inputs |

### How they fit together

- #24283 is independent of the other pull requests and does not change any public symbol.
- My scan-split experiment ([below](#the-compiler-is-part-of-the-result)) needs the lookup table from #23682, so I would only propose it on top of that change.
- #23675 with the first version of #24283 merged on top is faster than master on Cyrillic, CJK and French: Cyrillic takes 13–15% fewer cycles with GCC and 32–34% fewer with clang.

### SIMD ([#23675](https://github.com/php/php-src/pull/23675), [#22932](https://github.com/php/php-src/pull/22932), [#17734](https://github.com/php/php-src/pull/17734))

On long ASCII all three take 78–81% fewer cycles than master, about 5× faster. They differ on text with escapes spread through it. [#23675](https://github.com/php/php-src/pull/23675) keeps the vector loop going after each escape and takes 79% fewer cycles on HTML. [#22932](https://github.com/php/php-src/pull/22932) only skips the clean prefix before the first special byte, and after it runs at master's speed.

The cost is non-ASCII text with default flags. There every byte needs escaping, so the vector path never skips anything, and each character also pays for walking the block's bitmask. With GCC that makes Cyrillic and CJK 4–18% slower with #23675, and 17–29% slower with #17734 (GCC 13). With clang, #23675 takes 2–11% fewer cycles on the same inputs. Its loop is not better there. With clang, master saves seven registers to the stack around every call to the UTF-8 decoder, and #23675's new loop happens to avoid that ([details](#the-compiler-is-part-of-the-result)).

### The lookup table ([#23682](https://github.com/php/php-src/pull/23682))

A 256-byte table instead of the bit test removes instructions with every compiler: 25–33% fewer on ASCII. Whether that becomes time depends on the compiler.

Change in cycles against master, Intel i7-13700H (negative = fewer cycles, faster):

| input        | GCC 13 | GCC 14 | clang 18 | clang 20 |
| ------------ | -----: | -----: | -------: | -------: |
| ASCII, 4 KiB |   −21% |   −18% |       0% |      +2% |
| HTML         |   −19% |   −13% |      +7% |       0% |
| Cyrillic     |   +19% |   +21% |      −4% |       0% |

With GCC, Cyrillic gets slower with fewer instructions: branch mispredictions on that input go up about 2.5 times.

### Inline UTF-8 decoding ([#24283](https://github.com/php/php-src/pull/24283), mine)

`php_next_utf8_char_inline()` decodes valid UTF-8 at the call site and leaves every invalid sequence to the existing `php_next_utf8_char()`.

```text
master:
  php_json_escape_string()
    └─ php_next_utf8_char()               html.c, exported
         └─ get_next_char(cs_utf_8, ...)  switch over 14 charsets

#24283:
  php_json_escape_string()
    ├─ valid UTF-8 (2, 3 or 4 bytes) ──> decoded inline
    └─ invalid or truncated ──────────> php_next_utf8_char(), as before
```

The shortcut accepts exactly what the old code accepts. C2..DF followed by a continuation byte is always a valid shortest form. For three bytes it checks the same two conditions as the old code: not overlong, not a surrogate. For four bytes it checks the same range, U+10000..U+10FFFF. The two-byte case is the whole idea in small:

```c
if (EXPECTED(c < 0xe0)) {
	/* C2..DF + continuation byte: always a valid shortest form */
	if (c >= 0xc2 && avail >= 2 && (str[pos + 1] & 0xc0) == 0x80) {
		*cursor = pos + 2;
		*status = SUCCESS;
		return ((c & 0x1f) << 6) | (str[pos + 1] & 0x3f);
	}
}
```

On all six compilers, Cyrillic takes 9–30% fewer cycles than master, CJK 16–32% and emoji 11–18%. ASCII runs the same instructions as before.

The cost is on GCC on the Intel machine. With GCC 13 and 14 some inputs take 9–20% more cycles with the same instructions: a newline every 40 bytes, URLs, and ASCII with an occasional escaped é. With GCC 13 also 1,000 arrays (+10%) and 1,000 objects (+7%). `php_json_escape_string()` grows by 487 bytes, the functions after it move by 192 bytes, and branch mispredictions triple across the hot code, including code the change does not touch. Clang 18 and 20 on Intel and GCC 15 and clang 21 on AMD show nothing like it: from 9% fewer to 2% more cycles on the same inputs.

Two notes on the inputs. An input with an é exactly every 31 bytes looked worse at first, but that was the branch predictor learning the period, so the tables use é at random positions. And my other PR, [#24145](https://github.com/php/php-src/pull/24145) for `htmlspecialchars()`, makes `get_next_char()` always inline, which on its own takes 18% off Cyrillic. With both applied, #24283 still removes 14–20% of the instructions on non-ASCII text. With GCC that shows in cycles mostly on CJK and with `JSON_UNESCAPED_UNICODE`. This was measured with the first version of #24283.

## The compiler is part of the result

The most instructive part of this work was a change of my own that looked obviously right and was not. It is an experiment on top of #23682 and #24283, not a pull request yet.

Keeping the scan position in a register instead of on the stack, by not passing its address to the decoder, took 40–43% off HTML and 56% off a quote every 16 bytes with GCC 13 and 14. With clang it did nothing for ASCII, because clang already kept the position in a register and only stored a copy. With clang 20 it made HTML 17% slower and a newline every 40 bytes 42% slower: the loop ended up with two end-of-string checks per byte.

Reshaping the loop for clang broke Cyrillic for clang through branch mispredictions, and fixing that broke ASCII again. The way out was to stop fighting the compiler inside one large function:

- **Move the scan into a small function** that returns the length of the plain run. The main loop appends the run and handles one special character. The scan loop no longer depends on the code around it, and the position variable disappears.
- **Use the lookup table from #23682** in that scan. With a bit test, GCC 13 compiled the check to `shr %cl` instead of `bt` in the new context, whatever form I wrote it in. A table is one load and a compare on every compiler.

The experiment (scan split plus lookup table plus the first version of #24283), change in cycles against master, Intel i7-13700H:

| input                     | GCC 13 | GCC 14 | clang 18 | clang 20 |
| ------------------------- | -----: | -----: | -------: | -------: |
| ASCII, 4 KiB              |   −41% |   −46% |     −47% |     −47% |
| Cyrillic                  |   −35% |   −30% |     −34% |     −39% |
| CJK                       |   −22% |   −27% |     −41% |     −42% |
| a newline every 40 bytes  |   −61% |   −69% |     −33% |     −37% |
| 1,000 arrays of 10 fields |   −11% |    −8% |      −3% |      −9% |
| worst of 14 inputs        |     0% |    +3% |      +1% |      +5% |

The worst input is a quote in every byte with GCC, HTML, URLs or objects with clang 18, and URLs with clang 20.

So the table from #23682 is more than a smaller win. Once the scan is a loop of its own, it is the piece that makes the result the same on every compiler.

The same thing showed up from the other side in #23675. Counting instructions per non-ASCII character in `php_json_escape_string()`, master runs 74 with GCC and 93 with clang. Clang stores seven registers to the stack before every call to `php_next_utf8_char()` and loads them back after it. #23675 adds about 9 instructions per character for its bitmask walk with both compilers. But its new loop also happens to stop clang from spilling, so with clang it comes out ahead and with GCC behind. Neither result says much about the SIMD code itself.

Lessons I am keeping:

- Measure with the compilers the project's CI uses and with the one the distributions ship, not only the one on your machine.
- Equal instructions with different cycles mean code placement or branch prediction. Check the machine code and the branch counters before calling it an effect of the change.
- A hot loop inside a big function is at the mercy of everything else in that function.

## Next door

- **`htmlspecialchars()`.** [#23957](https://github.com/php/php-src/pull/23957), merged on 14 October 2026, returns the input when nothing needs encoding. [#24145](https://github.com/php/php-src/pull/24145), rebased on top of it and approved, speeds up strings that do need encoding: 44–64% fewer cycles (1.8–2.8× faster) on English, HTML, Markdown and JavaScript.
- **`json_decode()`.** Text escaped as `\uXXXX`, which `json_encode()` produces by default, is the expensive case for the decoder: the scanner matches every escape twice. Converting the hex digits without branches is the first, small step I am measuring.
- **Keys.** Keys repeat from record to record and are often interned (literal keys, declared properties, mysqlnd column names). So a per-call cache of keys that need no escaping looks worth measuring. It would not help SQLite or PostgreSQL rows, whose column names are not interned.

If your application sends a lot of non-ASCII JSON, I'd like to hear how these numbers look on your data. The [report for #24283](https://github.com/ArtUkrainskiy/php-src-bench/tree/main/reports/json-encode-utf8-inline) has the inputs (`cases.php`) and the script that measures them.

## Commits and data

Source links point to master at [`bd6c637d071`](https://github.com/php/php-src/commit/bd6c637d071). The changes were measured at these commits:

- on master [`bd6c637d071`](https://github.com/php/php-src/commit/bd6c637d071), with four compilers on Intel (#24283 also with two on AMD): #24283 at [`63792a2d9f5`](https://github.com/ArtUkrainskiy/php-src/commit/63792a2d9f5) (first version [`ca35c079a1f`](https://github.com/ArtUkrainskiy/php-src/commit/ca35c079a1f)), #23682 at [`5114f867221`](https://github.com/php/php-src/commit/5114f867221), #23675 at [`27d9c1cdd8c`](https://github.com/php/php-src/commit/27d9c1cdd8c);
- on master [`80d2b997192`](https://github.com/php/php-src/commit/80d2b997192), with GCC 13 only: #17734 at [`860b11f21c6`](https://github.com/php/php-src/commit/860b11f21c6), #22932 at [`9338aa1ebb7`](https://github.com/php/php-src/commit/9338aa1ebb7), #22492 at [`6e114dbbe96`](https://github.com/php/php-src/commit/6e114dbbe96).

The measurements of #24283, with raw runs and the commands to reproduce them, are in [php-src-bench](https://github.com/ArtUkrainskiy/php-src-bench/tree/main/reports/json-encode-utf8-inline). The numbers for #23675 and #23682 are in my comments on those pull requests. The raw data for #17734, #22932 and #22492 is not published yet.
