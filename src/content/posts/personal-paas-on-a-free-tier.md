---
title: A personal PaaS on a $0 budget
description: I built a small Heroku on Oracle's free tier. The interesting part wasn't the architecture — it was the four ways it quietly lied to me.
published: 2026-08-16
category: Engineering
tags: [kubernetes, gitops, argocd, oracle-cloud, infrastructure]
cover: /images/tinycloud-architecture.png
draft: false
---

I wanted to understand GitOps properly, and I don't think you can do that by reading about it. You have to run one long enough for it to break in ways the tutorials skip.

So I built a small personal platform on Oracle Cloud's Always Free tier. Push a commit, and a few minutes later it is running on Kubernetes with TLS, under a real domain. No `kubectl apply`. Every box in the diagram below costs nothing to run.

![The architecture: a push flows through GitHub Actions and GHCR into Argo CD, which reconciles onto k3s. Secrets come from OCI Vault at runtime; alarms leave the cluster entirely.](/images/tinycloud-architecture.png)

The architecture is the boring part. What follows is what actually happened.

## The constraints shape everything

Free tiers are not small versions of the paid thing. They are a different product with different holes, and you find the holes by hitting them.

Oracle's ARM allowance is 2 OCPUs and 12 GB of memory — and that is the whole allowance, not per instance. Two nodes consume it entirely. There is no third VM, which means no spare capacity, which means autoscaling has nothing to scale into and a build host has nowhere to live.

Then there were the services that simply refuse. The container registry returns:

```
HTTP 403  code: FREE_TIER_NOT_SUPPORTED
```

That is a tenancy-level block. No amount of fixing credentials or IAM policies changes it, which I established the slow way before accepting it and moving to GitHub's registry instead. Managed Kubernetes, Functions, API Gateway, DNS, and about ten other services are the same story: the API answers, the limit is zero.

The useful habit that came out of this: **check the limit, not the documentation.** A service showing `available: 0` is a wall. A marketing page saying "always free" is not a promise about your tenancy.

## The shape of it

A push to an application repository triggers a GitHub Actions build. The image goes to GHCR tagged with the commit SHA — never `latest`, because `latest` makes rollbacks a guessing game. Argo CD Image Updater notices the new digest and writes the new tag back into the GitOps repository as a commit. Argo CD sees that commit and reconciles it onto the cluster.

The loop closes without me. The only thing I do is push code.

Builds run in GitHub Actions rather than on my own hardware, and that was a real decision rather than laziness. I have a build coordinator that owns the queue, the job lifecycle and the logs — but the actual `docker build` needs a machine, and I don't have a spare one. So the coordinator dispatches to a workflow and the runner reports back over HTTP. The queue, history and logs stay mine; only the compute is borrowed.

## Nobody could decrypt my secrets, including me

The repository contained a `.sops.yaml` and an encrypted secrets file. It looked like the responsible thing: credentials in git, but safely.

It was decorative. Nothing in the cluster could decrypt SOPS — no operator, no key. That much I already knew, and had planned to fix.

What I hadn't checked was the other end. The file was encrypted to an age public key whose **private half existed nowhere**. Not on the machine that wrote it, not in a password manager, nowhere. `sops` and `age` weren't even installed.

So it wasn't a secret store, and it wasn't a backup either. It was an encrypted file that no living person could open, sitting in a repository, looking exactly like a safety net. If I had ever needed to rebuild from it, I would have discovered that during the emergency.

Deleting it was the easy part. The uncomfortable part was the question it raised: **what else looks like a backup?** The answer was four credentials — the GitHub OAuth app behind the console login, a PAT, a shared bearer token and a registry pull secret — that existed only as live objects in the cluster. Not in a repository, not in a vault, not anywhere. A cluster rebuild would have restored every manifest and no credential, and the failure would not have been obvious: the console would come back up and simply refuse to let anyone in, forever.

They live in OCI Vault now, read back into the cluster at runtime by External Secrets. The rule I follow since: if losing one object would lock me out, it needs to exist in two places, and I need to have tested the second one.

## Four ways the cluster lied to me

### Two owners, one object

I moved a Namespace manifest from one Argo application into another. Reasonable-looking change. Both applications now declared the same object, with different labels.

Server-side apply gives each manager ownership of the fields it declares and removes the ones it doesn't. So each sync reverted the other's labels. Pod Security enforcement switched itself on and off every few minutes, and both applications sat permanently out of sync while reporting successful syncs. Argo told me plainly once I looked — `SharedResourceWarning` — but the symptom I noticed first was a security setting that would not stay applied.

The fix is boring: one object, one owner. The lesson is that *"applied successfully"* and *"in the state I asked for"* are different claims.

### A field git never claimed

An application reported `OutOfSync` for days while every single sync succeeded. The diff was one field:

```yaml
source:
  directory:
    recurse: false
```

`false` is the zero value, so the API server drops the field entirely. Git asked for a state the cluster can never return. The diff could not close, and the sync had nothing to do — so it succeeded, forever, while never agreeing.

I hit this three separate times: on that field, then on CRD defaults in an ExternalSecret template, then on defaults one level deeper in the same resource. It is the same bug wearing different hats. Anything that reports drift by comparing declared state to live state has this failure mode, and the giveaway is always the same — **a resource that syncs successfully and stays out of sync.**

### `prune: true` and a moved manifest

This is the one that nearly cost me the platform.

Having decided one namespace should have one owner, I removed the Namespace from the application that shouldn't own it. Clean change. Except the live object was *tracked* to that application, and that application syncs with `prune: true`.

Removing a resource from a pruning application's desired state doesn't orphan it. It deletes it. And deleting a namespace deletes everything inside it — the API, the console, the ingress proxy, the auth proxy, all of it, in one reconcile that would have arrived within about three minutes.

I caught it because I went looking for which application held the tracking annotation before assuming I knew. The safe version takes two pushes: first mark the object `Prune=false` and let that land, then remove it. Ownership handovers are a two-step operation, and the intuition that "removing a line from a file is a small change" is exactly wrong here.

### Resources that exist in no repository

Argo CD's Image Updater ran happily for a month. It was described in no repository at all — installed once by hand, then forgotten. A rebuild from my own bootstrap scripts would have produced a cluster that looked correct and silently never updated an image again.

The same was true of the secret store, and of a service account left behind by a mechanism I had already replaced — which was still holding a cluster-wide permission to read a credential it no longer needed.

GitOps doesn't make this class of problem impossible. It makes it *invisible*, because everything you can see is beautifully declarative and the gap doesn't show up anywhere. The only defence I've found is to periodically ask the cluster what it is running and compare that to what the repository says — rather than the other way round.

## Moving the coordinator into the cluster

The build coordinator ran as a systemd unit on one node. I updated it by cross-compiling a binary, copying it over SSH and restarting the service. Two outages came directly from that: once a stale binary served a 404 for an endpoint that existed in the source, and once I simply forgot to redeploy.

Everything else on the platform deploys itself on push. This didn't, purely because it held state — a single SQLite file with every build and deploy record.

Moving it meant moving the database. The obvious approach, mounting the existing file into the pod, is unavailable: the namespace enforces the `restricted` Pod Security Standard, which forbids `hostPath` volumes outright. Relaxing that for one workload would lower the floor for every other workload in the namespace.

So the file went onto a node-local volume, seeded before the pod ever started. That ordering matters more than it sounds. Start the pod first and it creates an empty schema, comes up perfectly healthy, and shows a console with zero build history — which is indistinguishable from having lost the lot. I bound the volume with a temporary pod, copied the database in, verified the checksums matched on both sides, and only then let Argo start the real thing.

It came up with all its history. But "healthy and empty" is a failure mode worth naming, because nothing alerts on it.

## What's still broken

The platform can build an application exactly once.

Builds fire when an app is created. There is no rebuild endpoint, nothing watching application repositories for new commits, and three separate guards that reject a build for an app that already exists. Image Updater will faithfully deploy a newer image the moment one appears in the registry — but nothing ever builds one.

So the deploy half is genuinely automatic and the build half fires once and retires. I found this by trying to run a build to test the coordinator migration, and getting a `409 Conflict` instead of a pipeline run. Which is its own small lesson: I had been describing this thing as fully automatic for weeks, and the first time I actually exercised the path end to end, it wasn't.

That's next.

## The thread running through all of it

Every failure here was an ownership question wearing a costume.

Which application owns this object? Which field does this manager own? Does this thing exist in a repository, or only in my cluster? Is this file a backup, or does it just look like one?

None of them were exotic Kubernetes problems. They were all versions of *"I assumed I knew who was responsible for this, and I was wrong."* The tooling is very good at telling you it succeeded. It is much worse at telling you that what succeeded wasn't what you meant.

The platform runs nine applications, costs nothing, deploys on push, keeps its secrets in a vault, and alerts me from outside the cluster when it breaks. I trust it considerably more now that I know exactly which parts of it I shouldn't.
