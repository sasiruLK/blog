---
title: A 2FA plugin for Omarchy, and the rejections that designed it
description: Omarchy 4 lets anyone extend the desktop shell with a manifest and a few QML files. Before writing mine I went and read the marketplace's pile of rejected submissions, which turned out to be a better design document than the documentation.
published: 2026-08-19
category: Engineering
tags: [omarchy, qml, quickshell, linux, security, totp]
cover: /images/omarchy-2fa.png
draft: false
---

The codes live on my phone, and my phone is never where I am. Not a hardship — six digits, twice a day, a few seconds of reaching. But it's the kind of small friction you stop noticing until something makes it optional, and then you notice it constantly.

Omarchy 4 made it optional. I updated mostly for the usual reasons and found a plugin system I hadn't been expecting, which is how I ended up with an authenticator in my status bar instead of an early night.

## What a plugin actually is

Almost nothing, which is the appeal. A directory under `~/.config/omarchy/plugins/`, a `manifest.json`, and some QML:

```json
{
  "schemaVersion": 1,
  "id": "io.github.sasirulk.totp",
  "name": "2FA",
  "version": "0.1.0",
  "kinds": ["bar-widget"],
  "entryPoints": { "barWidget": "Panel.qml" }
}
```

`kinds` declares what you're supplying — a bar widget, a panel, an overlay, a menu, a headless service, or a complete replacement bar — and `entryPoints` says which file to load for each. `omarchy plugin validate` checks the whole contract before the shell ever sees it. Save a file and it reloads. There is no build step, no packaging, no SDK to install. The first version that drew a live code in my bar was a manifest and one QML file, and it took an evening.

The part worth sitting with is where that code runs. Omarchy's bar, notifications, panels and lock screen all live in one long-running Quickshell process called `omarchy-shell`, and your plugin is loaded *into it*. Not a subprocess. Not a sandbox. The same process, with your user's permissions, for as long as you're logged in.

For a clock, that's an implementation detail. For the thing holding every second factor I own, it's the whole problem.

## The detour that designed everything

So before writing anything real I went and read the marketplace.

It's an independent community project, and its submission process happens entirely in public GitHub issues: you open one, a bot validates your repository and runs a static security baseline, and a maintainer reads your code and either approves it or explains, on the issue, exactly why not. At the time I looked there were about 525 listed plugins across some seven hundred submission threads. Around a hundred carried a `needs-fixes` label.

I read every maintainer verdict I could find — sixty-odd of them — expecting a grab-bag of one-off mistakes. It isn't. It's the same handful of failures, over and over, and one of them accounts for more rejections than everything else combined.

It's the default value of a Qt property.

QML's `Text` element defaults to `textFormat: Text.AutoText`, which sniffs the string you hand it and renders it as rich text if it looks like markup. Hand it `<img src="http://example.com/x">` and Qt does the obvious thing: it fetches the URL. Now consider what plugins display. Track metadata from whatever media player is running. Notification bodies. RSS titles from an imported OPML file. Window titles. A Bluetooth device's advertised name. OCR output. Clipboard contents.

All of it is text from somewhere else, and all of it was being rendered with a default that turns text from somewhere else into a network request from a process that runs for as long as your session does. Blocked submissions, one after another, with near-identical verdicts:

> …track metadata is passed to QML `Text` items without plain-text mode, allowing HTML-like media metadata to be interpreted as rich text and load referenced resources.

Nobody wrote a beacon. They all just didn't set a property.

The rest of the pile rhymes. Files created and *then* `chmod`-ed, losing a race under a normal umask, so there's a window where another local user can read your credentials. Removal instructions that delete a plugin but leave its API keys behind. Secrets passed as command-line arguments, where `/proc/<pid>/cmdline` is world-readable. Plugins that documented one thing and did another.

I came away thinking the rejection pile is a better specification than the documentation. Documentation tells you what's possible. Rejections tell you which parts are load-bearing.

## What that turned into

Everything about the plugin's shape is downstream of that afternoon.

**The secrets don't live in a file.** They go into the login keyring, one entry per account, through the Secret Service. What lands on disk is an index — account names, digit count, period, algorithm — and nothing else. A copy of that file names your accounts and cannot generate a single code. It's created `0600` from the start, by setting a umask before anything is written rather than correcting the mode afterwards, because the pile taught me that correcting it afterwards is a bug with a window in it.

**No secret ever becomes a command-line argument.** `secret-tool` takes them on stdin. So do `wl-copy` and `wtype` when a code is copied or typed. This costs nothing and closes a hole that other submissions were blocked for.

**Every `Text` in the plugin sets `textFormat: Text.PlainText`.** Account labels come out of QR codes that somebody else generated — they are the most attacker-controlled strings in the entire design. I didn't want to take this one on faith, so I tested it properly: an account whose issuer and label were both `<img src="http://127.0.0.1:9099/pwn">`, and a listener on that port to record any connection. Opened the panel. The label rendered as literal text, the code generated fine, and the listener logged nothing — while a control request proved it was working and would have logged a hit. That's the difference between believing you're safe and knowing it.

**And no network access at all.** TOTP is arithmetic over a shared secret and the current time. There is no server to talk to, so there's no HTTP client anywhere in the source, and the whole rich-text problem exists precisely because it's a way to make a network request without writing one.

![The 2FA panel open in the Omarchy bar, showing three accounts with live six-digit codes and countdowns](/images/omarchy-2fa.png)

## The QR code is a screenshot

My favourite thing I learned here is that "scan the QR code" on a desktop doesn't mean a camera.

The code is already on your screen. It's in the browser tab where the site is walking you through setup. So `grim` photographs the screen, `zbarimg` decodes it, and out comes the `otpauth://` URI the site would have given your phone. All three tools ship with Omarchy already, which meant the finished plugin has no dependencies a user has to install — no `sudo`, no installer script, nothing outside its own directory.

I got the interaction wrong the first time, and only worked that out by using it on a real enrolment page. The first version closed the panel, then opened a region selector so you could drag a box around the code. Reasonable on paper. In practice you click "scan", the interface vanishes, and you're left dragging a rectangle over a browser wondering whether anything is happening.

It now photographs the whole screen *with the panel still open* — it's a small card in a corner, the code is rarely underneath it — finds the link and adds the account. Nothing moves. The region selector is still there for when the full-screen pass finds nothing, but most of the time there's no cropping step at all, because there didn't need to be one.

## What the tests caught that I didn't

Two bugs are worth writing down, because both were invisible to the way I was testing.

The first: adding a second account hung forever. Each subprocess that receives a secret gets it on stdin, and stdin has to be *closed* afterwards to signal end-of-input — otherwise `secret-tool` waits for data that will never arrive. What I missed is that the closed state sticks to the object. The second time the same process was launched it had no stdin pipe at all, so it sat there indefinitely, holding a secret, waiting on a channel that no longer existed. Which is, almost word for word, a pattern the maintainers had already blocked another plugin for.

The second: adding three accounts quickly kept only one. The index file was being watched for changes, and a reload triggered by my own write would land *after* the next write had already updated the in-memory list — replacing newer state with the version it had just read off disk.

Neither is exotic. Both are completely invisible if you add one account by hand and admire it, which is exactly what I'd been doing. They turned up the moment I wrote a harness that adds three in a row and checks all three are still there afterwards.

There's a third thing I'd have shipped: an export. Locking every second factor I own inside one keyring, with no way out, is not a feature — it's a hostage situation with good intentions. So the plugin exports every account as standard `otpauth://` links, which any other authenticator can read, encrypted with GnuPG under a passphrase. Encryption isn't optional there: an export contains every shared secret in full, and one sitting unencrypted in a home directory would undo the entire point of the keyring. The passphrase reaches `gpg` through a FIFO — it can't go on the command line, and it shouldn't be written to disk, and stdin is already carrying the plaintext.

## What it actually taught me

The interesting decision in Omarchy's plugin system isn't technical. It's that there's no sandbox, and rather than pretend otherwise, everything is arranged around making that honest. Plugins run unsandboxed and the docs say so in as many words. The marketplace's answer isn't isolation, it's legibility: a deterministic scanner that only claims to detect what it documents, a human reading the actual commit, and — the part that did the work for me — every verdict published in the open where the next person can read it.

That's a real trade. It asks more of the person installing something than a permissions dialog does. But a permissions dialog wouldn't have caught a default text format, and sixty public rejections did.

The other thing is smaller and more embarrassing. Every bug I shipped into my own testing had the same shape: I checked that the first one worked. First account added, first code copied, first export written. All of them fine. The failures were all in the second — the reused process, the second write racing the first, the second scan of a code already stored. I've been writing software long enough to know that "it worked" and "it works" are different claims, and I still had to be shown the difference by a test that simply did the thing twice.

The plugin is [on GitHub](https://github.com/sasiruLK/omarchy-totp), MIT, about nine hundred lines. It's submitted to the marketplace and waiting on a maintainer, which feels like the right way round: I got to read everyone else's review before mine.
