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

That animation is the whole design in four passes — deploy, secrets, traffic, alerts. The rest of this post is why each one is shaped that way, and what happened when I finally looked closely at the parts I'd stopped checking.

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

Concretely: a push triggers a GitHub Actions build. The image goes to GHCR tagged with the **commit SHA** — never `latest`, because `latest` makes "which version is running?" unanswerable and rollback a guess. Argo CD Image Updater notices the new digest and writes the tag into the GitOps repository as a commit. Argo CD sees that commit and reconciles.

The loop closes without me. Note what Image Updater does *not* do: it doesn't touch the cluster. It writes to git and lets the same reconciliation path handle it, so there is exactly one way anything is deployed.

## Why builds run on someone else's computer

The whole ARM allowance is 2 OCPUs and 12 GB — not per instance, total. Two k3s nodes consume all of it. There is no third VM, so a build host has nowhere to live.

The design response is to split the build plane in two. I run a **coordinator** that owns the queue, the job lifecycle and the logs. It dispatches the actual `docker build` to GitHub Actions, and the runner reports progress back over HTTP. The state and the history stay mine; only the compute is borrowed.

This is worth generalising: when a resource is scarce, look for the part of the job that actually needs it. "Building" felt indivisible until I separated *deciding what to build and remembering what happened* from *executing the build*. Only the second half needs a machine.

## The file nobody could decrypt

The repository had a `.sops.yaml` and an encrypted secrets file. It looked like the responsible thing: credentials in git, but safely.

It was decorative. Nothing in the cluster could decrypt SOPS — no operator, no key. I already knew that much and had it on a list to fix.

What I hadn't checked was the other end. The file was encrypted to an age public key whose **private half existed nowhere.** Not on the machine that wrote it, not in a password manager, nowhere. `sops` and `age` weren't even installed.

So it wasn't a secret store, and it wasn't a backup either. It was an encrypted file that no living person could open, sitting in a repository, looking exactly like a safety net. I'd have discovered that during the emergency it was supposed to cover.

The uncomfortable part wasn't deleting it. It was the question it raised: **what else looks like a backup?**

The answer was four credentials — the GitHub OAuth app behind the console login, a personal access token, a shared bearer token between two services, and the registry pull secret — that existed only as live objects in the cluster. Not in a repository. Not in a vault. Nowhere. A rebuild would have restored every manifest and no credential, and the failure mode is nasty precisely because it isn't loud: the console would come back up perfectly healthy and refuse to let anyone in, forever.

They live in a managed vault now, read back at runtime by an operator. The repository declares *which* secret goes where and never the value. The rule I'd keep on any project: **if losing one object locks you out permanently, it must exist in two places, and you must have tested the second one.**

### Adopting a secret without breaking it

Moving live credentials under a controller is the kind of change that can lock you out while you're making it, so it went in stages: write the values to the vault first, then have the operator produce a Secret under a *throwaway* name, then compare that against the real one byte for byte. Only once they matched identically did the real name get adopted. No pod restarted, because no data changed.

There was one non-obvious decision. Most examples use `creationPolicy: Owner`, which sets an owner reference from the Secret to the resource that declares it. That means deleting the declaration garbage-collects the credential. For a login secret, that turns a bad rebase into a permanent lockout — and the recovery path is the object you just deleted. I used `Orphan` instead: it still creates the secret on a rebuild, which is the whole point, but leaves it standing if the declaration goes away. The worst case becomes one stale Secret rather than no way to log in.

### Seven objects to copy one file

The pull secret had its own accidental complexity. Each application namespace got a copy of the registry credential via a pre-sync hook: a Job, a ServiceAccount, a Role, a RoleBinding, and a NetworkPolicy opening egress to the API server — seven objects whose entire purpose was to duplicate one credential into a namespace. Every app namespace ended up with an identity permitted to read Secrets elsewhere in the cluster.

One declarative secret reference replaced all of it. No Job, no RBAC, no API server access, and it re-reconciles on its own when the credential rotates instead of staying stale until someone syncs the app again.

When I cleaned up, I found the old machinery's ServiceAccount, Role and a **cluster-wide** RoleBinding still sitting there, months after the Job that used them had run. Pre-sync hooks are deleted before the *next* hook runs — so when the hook itself is removed, nothing ever triggers the cleanup. They just stay, holding permissions for a mechanism that no longer exists.

## Where the state lives is the hard part

Everything above is stateless and therefore easy. One component isn't: the build coordinator keeps every build and deploy record in a single SQLite file.

It also used to run as a systemd unit on one node, updated by cross-compiling a binary, copying it over SSH and restarting the service. Two outages came directly from that: once a stale binary served a 404 for an endpoint that existed in the source, and once I simply forgot to redeploy. Everything else deploys itself on push. This didn't, purely because it held state.

Moving it into the cluster meant moving the database, and that one file forces four decisions.

**It pins the pod to a node.** The volume is node-local storage — a directory on one machine's disk. So the pod carries a node selector, permanently. If it ever scheduled elsewhere it would either find an empty directory and migrate a fresh schema, or refuse to start with a volume affinity conflict. The second failure is far better than the first, and the design should prefer the loud one.

**It forbids rolling updates.** SQLite tolerates concurrent readers, not two independent writers across a read-write-once volume. A rolling update briefly runs both pods. So the deployment uses `Recreate` — a few seconds of downtime per deploy, in exchange for never corrupting the database. For a queue that already tolerates the coordinator being briefly unreachable, that's the right trade.

**It can't use the obvious volume.** Mounting the existing file straight off the host is forbidden: the namespace enforces the `restricted` Pod Security Standard, which blocks `hostPath` outright. I could have relaxed the namespace — and lowered the security floor for every other workload in it, to save myself one migration.

**Seeding order matters more than it sounds.** Start the pod against an empty volume and it creates a schema, reports healthy, and serves a console with zero build history. That is indistinguishable from data loss, and nothing alerts on it. So the volume was bound by a temporary pod, seeded with the real database, and checksummed on both sides before the workload ever started. **"Healthy and empty" is a failure mode worth naming**, because every probe you have will call it fine.

### The cutover has a split-brain window

While the coordinator lived outside the cluster, traffic reached it through a Service with no selector and a hand-written endpoint pointing at the node's IP. Turning it into a pod means giving that Service a real selector.

The trap: the hand-written endpoint object doesn't disappear because the Service gained a selector. Until it's explicitly deleted, it coexists with the controller-managed one, and traffic load-balances between the new pod and the old process — which is still running, still has valid credentials, and is still writing to *its* copy of the database. Roughly half your requests land in a parallel universe.

So the order is: cut the old endpoint first, accept a brief window where the service is simply unavailable, then let the pod take over. Unavailable is a much better failure than silently split.

## Designing for the failure you can't see

The last requirement — keep working when a piece dies — mostly means being honest about who watches the watchman.

Alarms are evaluated by the cloud's monitoring service, outside the cluster, and delivered by email. This matters more than it sounds: monitoring that lives inside the cluster it monitors goes down exactly when you need it, and its silence is indistinguishable from everything being fine. **Anything that alerts on your system should fail independently of your system.**

Build logs ship off-cluster for a related reason: the primary record is that single SQLite file on one node's disk, and node-local storage does not survive the node. So every log line and lifecycle transition is also written to a managed logging service as structured JSON.

Two properties matter in that shipper, and both are about refusing to let the secondary copy hurt the primary:

- **It never blocks.** It sits on the path that serves build log callbacks. If the logging endpoint is slow, entries are dropped rather than queued, because a full buffer must cost log lines and not stall the coordinator.
- **It's a no-op when unconfigured.** Not an error, not a warning on every call — the whole thing degrades to nothing if you don't set it up. Shipping a backup copy of logs is never a good reason to fail a build.

Entries are batched by count and by interval, because one network round trip per log line would be thousands of them for a verbose build.

## Four ways the cluster lied to me

Everything above is design. This part is what happened when I checked whether the design was actually true.

### Two owners, one object

I moved a Namespace manifest from one application into another. Reasonable-looking change. Both applications now declared the same object with different labels.

Server-side apply gives each manager ownership of the fields it declares and removes the ones it doesn't. So each sync reverted the other's labels. Pod Security enforcement switched itself on and off every few minutes, and both applications sat permanently out of sync while reporting successful syncs. The controller had a name for it — `SharedResourceWarning` — but the symptom I noticed first was a security setting that would not stay applied.

One object, one owner. And *"applied successfully"* is a different claim from *"in the state I asked for."*

### A field git can never claim

An application reported out-of-sync for days while every single sync succeeded. The diff was one field:

```yaml
source:
  directory:
    recurse: false
```

`false` is the zero value, so the API server drops the field entirely. Git asked for a state the cluster can never return. The diff couldn't close, and the sync had nothing to do — so it succeeded, forever, while never agreeing.

I hit this three separate times in one week: on that field, then on defaults inside a secret template, then on defaults one level deeper in the same resource. It's the same bug wearing different hats, and anything that reports drift by comparing declared state to live state has this failure mode. The giveaway is always identical: **a resource that syncs successfully and stays out of sync.**

### One line that nearly deleted everything

Having decided one namespace should have one owner, I removed the Namespace from the application that shouldn't own it. Clean change, three lines.

Except the live object was *tracked* to that application, and that application syncs with pruning enabled. Removing a resource from a pruning application's desired state doesn't orphan it — it deletes it. And deleting a namespace deletes everything inside it: the API, the console, the ingress proxy, the auth proxy, all of it, in a reconcile that would have arrived within about three minutes.

I caught it because I went looking for which application actually held the tracking annotation instead of assuming I knew. The safe version takes two pushes: mark the object as never-prune, let that land, *then* remove it.

The intuition that "deleting a line from a file is a small change" is exactly backwards here. In a system where a file is the desired state, deleting a line is a deletion.

### Things that exist in no repository

The image updater had been running for a month. It was described in no repository at all — installed once by hand, then forgotten. A rebuild from my own bootstrap scripts would have produced a cluster that looked completely correct and silently never updated an image again.

Same for the secret store. Same for that leftover ServiceAccount with cluster-wide read on a credential.

GitOps doesn't make this impossible. It makes it *invisible*, because everything you can see is beautifully declarative and the gap doesn't appear anywhere. The only defence I've found is to periodically ask the cluster what it's running and compare that to the repository — rather than the other way around, which is the direction that feels natural and tells you nothing.

## The documentation was lying too

My infrastructure runbook opened by calling itself "the single description of what exists." Checking it line by line against the live tenancy:

- It said the GitOps controller was on 2.x. It was on 3.x — I'd upgraded it and never updated the doc.
- It said five applications. There were nine.
- It said no vault existed in the tenancy. One existed and the cluster was actively reading secrets from it.
- It said zero alarms were configured, describing them as unbuilt work. Six were enabled and wired to email.
- It documented a build runner component with instructions to re-enable it on a specific host. The component had been deleted; the host had nothing to do with builds any more.
- The platform's own console had a "blocked services" list claiming a managed database was unavailable. It was available. I'd checked the paid shapes sitting next to the free one and written the whole thing off.

Every one of those was true when written. Documentation doesn't rot because you write it badly, it rots because the system keeps moving and nothing forces the page to move with it. A runbook that confidently states six wrong facts is worse than no runbook, because you stop verifying.

The fix I've settled on is unglamorous: the doc carries a "verified on" date, and verifying means running the commands, not reading the page.

## What I got wrong

The design above is the honest version, and it has a hole I only found by testing it.

The platform can build an application **exactly once.** Builds fire when an app is created; there is no rebuild path, nothing watching app repositories for new commits, and three separate guards reject a build for an app that already exists. Image Updater will deploy a newer image the moment one appears — but nothing ever builds one.

So the deploy half is genuinely automatic, and the build half fires once and retires. I found it by trying to run a build to verify the coordinator migration and getting a `409 Conflict` instead of a pipeline run. I had been describing this thing as fully automatic for weeks; the first time I exercised the path end to end, it wasn't.

That's the next piece of design work, and it's a real one: rebuilds need a trigger, and every option — webhook, poll, manual button — is a different trade between latency, credentials I'd have to hold, and how much of someone else's repository I want to know about.

## What it actually taught me

Every failure in this post is an ownership question wearing a costume.

Which application owns this object? Which field does this controller own? Does this thing exist in a repository, or only in my cluster? Is that file a backup, or does it just look like one? Is this document describing the system, or describing the system as it was eight months ago?

None of them were exotic Kubernetes problems. They were all versions of *"I assumed I knew who was responsible for this, and I was wrong."* The tooling is very good at telling you it succeeded. It's much worse at telling you that what succeeded wasn't what you meant.

Which is the part I didn't expect to get out of this. I set out to learn how a platform works and mostly learned how much of one is *judgement* — where to put state, which failure to prefer, what to refuse to automate, when "it's working" is a claim you haven't actually checked. Vercel makes all of those calls for me and I never see one of them. Our IDP makes them for our engineers, and they mostly shouldn't have to see them either. That invisibility is the product working. It just costs somebody, somewhere, a fairly long afternoon deciding whether a rolling update can corrupt a SQLite file.

I'm better at my day job for having built the bad version of it.
