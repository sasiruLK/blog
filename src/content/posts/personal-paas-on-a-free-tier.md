---
title: Designing a personal PaaS on a $0 budget
description: I work on an internal developer platform by day and ran my side projects on Vercel by night. I wanted to know what both were doing while I wasn't looking, so I built the small version myself.
published: 2026-08-16
category: Engineering
tags: [system-design, kubernetes, gitops, argocd, oracle-cloud]
cover: /images/tinycloud-architecture.png
draft: false
---

At work I spend most of my time on our internal developer platform — the thing other engineers push to without having to think about what happens next. That's the whole point of it. But standing on the other side of that abstraction changes how you see it. You stop experiencing "it just deploys" as a convenience and start seeing the machinery holding it up, mostly because you are the one holding it.

Before that, everything I built for myself lived on Vercel. Push to main, get a URL. I never once thought about it, which is the highest compliment you can pay a platform and also the reason I never learned anything from it. It stayed magic because it never gave me a reason to look.

So the two things met in the middle. The IDP work gave me the vocabulary — desired state, reconciliation, drift, the difference between *deploying* something and *converging* on it — and I wanted to find out whether I understood any of it well enough to build the small version myself. Not to replace Vercel. To find out what Vercel is doing while I'm not looking.

I built it on Oracle Cloud's Always Free tier, partly for the constraint and partly because $0 is a satisfying budget. Push a commit, and a few minutes later it is running on Kubernetes with TLS under a real domain.

No `kubectl apply`. Every box below costs nothing to run.

![Four flows through the system: a push travels from GitHub Actions through GHCR into Argo CD and onto the cluster; secrets arrive from OCI Vault at runtime; visitor traffic enters through Traefik; alerts leave the cluster to email.](/images/tinycloud-architecture.gif)

That animation is the whole design in four passes — deploy, secrets, traffic, alerts. The rest of this post is why each one is shaped that way.

## The requirement, stated properly

"Push code, get a running app" hides at least five separate problems:

1. Something must **build** a container image, on hardware I don't have spare.
2. Something must **store** it, addressably, so a specific version can be named later.
3. Something must **decide** what should be running — and that decision has to survive me forgetting what I did.
4. Something must **make reality match** that decision, continuously, not once.
5. It has to keep working when a piece of it dies, including the piece that would have told me.

Most of the interesting design pressure comes from 3, 4 and 5. Building and storing images is largely solved by other people.

## The control loop is the whole idea

The core decision is **pull, not push.**

A push-based pipeline ends with CI running a deploy command. It works, and it has a quiet flaw: CI's job finishes at the moment of deployment, so nothing is responsible for the cluster afterwards. If someone edits a live resource by hand, or a controller mangles something at 3am, the pipeline has no opinion. It already succeeded. The cluster drifts and the last green checkmark stays green.

A pull-based loop inverts that. A controller inside the cluster holds a repository as the **desired state** and continuously compares it against live state:

- Deploying is a git commit. There is no other entry point.
- Drift is not just detected, it is *corrected* — the controller reverts hand edits.
- Rollback is `git revert`, because the previous desired state is a commit.
- The audit log is the git log, and it is complete by construction.

The cost is a layer of indirection, and one genuinely subtle failure mode I'll come back to.

Concretely: a push triggers a GitHub Actions build. The image goes to GHCR tagged with the **commit SHA** — never `latest`, because `latest` makes "which version is running?" unanswerable and rollback a guess. Argo CD Image Updater notices the new digest and writes the tag into the GitOps repository as a commit. Argo CD sees that commit and reconciles.

The loop closes without me. Note what Image Updater does *not* do: it doesn't touch the cluster. It writes to git and lets the same reconciliation path handle it, so there is exactly one way anything is deployed.

## Why builds run on someone else's computer

The whole ARM allowance is 2 OCPUs and 12 GB — not per instance, total. Two k3s nodes consume all of it. There is no third VM, so a build host has nowhere to live.

The design response is to split the build plane in two. I run a **coordinator** that owns the queue, the job lifecycle and the logs. It dispatches the actual `docker build` to GitHub Actions, and the runner reports progress back over HTTP. The state and the history stay mine; only the compute is borrowed.

This is worth generalising: when a resource is scarce, look for the part of the job that actually needs it. "Building" felt indivisible until I separated *deciding what to build and remembering what happened* from *executing the build*. Only the second half needs a machine.

## Secrets: pull at runtime, never store

Secrets can't live in git, so they need their own path into the cluster.

They live in a managed vault, and an operator inside the cluster pulls them at runtime into Kubernetes Secrets. The repository declares *which* secret goes where, never the value. Rotation happens in the vault and propagates on the next refresh.

The design rule I'd keep on any project: **if losing one object locks you out permanently, it must exist in two places, and you must have tested the second one.** My console login is a GitHub OAuth app. If that secret vanished, the platform would come back up perfectly healthy and refuse to let anyone in, forever. That asymmetry — healthy but locked out — is worth designing against specifically.

## Where the state lives is the hard part

Everything above is stateless and therefore easy. One component isn't: the build coordinator keeps every build and deploy record in a single SQLite file.

That one file forces four decisions:

**It pins the pod to a node.** The volume is node-local storage — a directory on one machine's disk. So the pod carries a node selector, permanently. If it ever scheduled elsewhere, it would either find an empty directory and migrate a fresh schema (history apparently gone) or refuse to start at all. The second failure is much better than the first, and the design should prefer the loud one.

**It forbids rolling updates.** SQLite tolerates concurrent readers, not two independent writers across a read-write-once volume. A rolling update briefly runs both pods. So this deployment uses `Recreate` — a few seconds of downtime per deploy, in exchange for never corrupting the database. For a queue that already tolerates the coordinator being briefly unreachable, that is the correct trade.

**It can't use the obvious volume.** Mounting the existing file from the host is forbidden: the namespace enforces the `restricted` Pod Security Standard, which blocks `hostPath` outright. I could have relaxed the namespace — and lowered the floor for every other workload in it, to save one migration.

**Seeding order matters more than it sounds.** Start the pod against an empty volume and it creates a schema, reports healthy, and serves a console with zero history. That is indistinguishable from data loss, and nothing alerts on it. So the volume gets seeded *before* the workload ever runs, with checksums compared on both sides. **"Healthy and empty" is a failure mode worth naming.**

## Designing for the failure you can't see

The last requirement — keep working when a piece dies — mostly means being honest about *who watches the watchman*.

Alarms are evaluated by the cloud's monitoring service, outside the cluster, and delivered by email. This matters more than it sounds: monitoring that lives inside the cluster it monitors goes down exactly when you need it, and its silence is indistinguishable from everything being fine. Anything that alerts on your system should fail *independently* of your system.

Build logs are shipped off-cluster too, for a related reason: the primary record is that single SQLite file on one node's disk, and node-local storage does not survive the node. The copy is best-effort by design — if the log endpoint is slow, entries are dropped rather than queued, because the secondary copy must never be able to stall the thing producing it.

The gap I still have: the external prober that watches from outside is capped on the free tier, so my time-to-detection for a full outage is tens of minutes rather than one. Known, measured, not yet fixed.

## What the free tier actually forces

Free tiers are not smaller versions of the paid product. They are a different product with different holes, and you find the holes by hitting them.

The container registry, for instance, doesn't fail on credentials — it refuses at the tenancy level:

```
HTTP 403  code: FREE_TIER_NOT_SUPPORTED
```

No amount of fixing IAM changes that, which I established the slow way. Managed Kubernetes, Functions, API Gateway and about ten others are the same story: the API answers, the limit is zero.

The habit that came out of it: **check the limit, not the documentation.** A service reporting `available: 0` is a wall. A page saying "always free" is not a promise about your tenancy. I later found I'd written off a database service that was in fact available, because I checked the paid shapes sitting next to the free one — the same mistake in the opposite direction.

## What I got wrong

The design above is the honest version, but it has a hole I only found by testing it.

The platform can build an application **exactly once.** Builds fire when an app is created; there is no rebuild path, nothing watching app repositories for new commits, and three separate guards that reject a build for an app that already exists. Image Updater will deploy a newer image the moment one appears — but nothing ever builds one.

So the deploy half is genuinely automatic and the build half fires once and retires. I found it by trying to run a build to verify a migration and getting a `409 Conflict` instead of a pipeline run. I had been describing this thing as fully automatic for weeks; the first time I exercised the path end to end, it wasn't.

That's the next piece of design work, and it's a real one: rebuilds need a trigger, and every option — webhook, poll, manual button — is a different trade between latency, credentials I'd have to hold, and how much of someone else's repository I want to know about.

Which is the part I didn't expect to get out of this. I set out to learn how a platform works and mostly learned how much of one is *judgement* — where to put state, which failure to prefer, what to refuse to automate. Vercel makes all of those calls for me and I never see one of them. Our IDP makes them for our engineers and they mostly shouldn't have to see them either. That invisibility is the product working. It just costs somebody, somewhere, a fairly long afternoon deciding whether a rolling update can corrupt a SQLite file.

I'm better at my day job for having built the bad version of it.

---

*There's a companion post coming on the four ways this cluster quietly lied to me — two controllers owning one object, a field git can never claim, and a one-line change that nearly deleted the namespace. Those are debugging stories rather than design ones, so they get their own post.*
