+++
title = "Why I Migrated My Blog from Astro to Zola"
description = "After learning Rust full-time, I decided to rebuild my blog using Zola. Here’s what I learned comparing Astro and Zola — from performance gains to simpler workflows"
date = 2025-10-18
draft = false

[taxonomies]
categories = ["rust", "performance"]
tags = ["rust", "performance"]

[extra]
lang = "en"
toc = true
comment = true
copy = true
outdate_alert = false
outdate_alert_days = 120
math = false
mermaid = false
featured = true
reaction = true

+++

# Journey with Astro

After I got to know about Astro a few years ago, I thought this was the best way to create a blog. So I created my blog, and I remember I changed the theme every once in a while without writing any blog posts. In 2022, I was determined to write a blog post and, at the time, was really interested in how this modern frontend framework works behind all this, especially React. I came across these two websites [Build Your Own React](https://pomb.us/build-your-own-react/) and [Create a Frontend Framework](https://mfrachet.github.io/create-frontend-framework/), and learned a lot from those. I highly recommend that you read them too. Then I created this blog post about optimizing React with the knowledge that I gathered. To date, that's the only blog post I wrote, but I am proud of what I did.

Up until then, I was a full-stack developer, mostly working on Node.js and React/Vue.js frameworks. Then I had a big accident and had to rest for a while. While spending most of my time in bed, I wanted to learn Go, so I started learning it, and after a while, I was fortunate enough to find a remote job to work on Go. Then I was solely focused on backend API development. Recently, the project we were building, we wanted to rewrite in Rust. I started to learn Rust. After spending time learning Rust at work, I naturally hit the point every Rust programmer hits: *“Why not rewrite my blog in Rust?”* It’s like a secret Rust club ritual — first your APIs, then your blog, and eventually even your shopping list. It showed me a few options, but I liked Zola because out of all of them, Zola had good documentation.  

# Problems I faced with astro

Astro is a good framework that is easy to work with, but it comes with some challenges related to the npm ecosystem. Since I only had a one-page blog, I didn’t encounter many issues. However, for a blog with just one post, the build time was surprisingly high. I faced this problem frequently when migrating to a new laptop or installing a new operating system. Whenever I cloned my repository and tried to run `npm install`, it caused some issues that prevented it from working properly. While these issues were minor compared to the benefits Astro provides—such as the ability to implement beautiful UI elements with engaging interactions—maintaining a markdown blog with it proved to be more trouble than it was worth. 

# Performance Difference

I wanted to compare the performance of Zola and Astro, so I created a bash script to measure build time, production build size, and memory usage of the development server. Here are my findings:

| Framework | Build Time | Output Size | Dev Server Memory |
|-----------|------------|-------------|--------------------|
| Astro     | 3.703s     | 16M         | 73.61 MB           |
| Zola      | 0.055s     | 644K        | 42.96 MB           |

- **Build Time:** Zola is approximately 67 times faster than Astro.
- **Output Size:** The build output from Zola is about 25 times smaller than that of Astro.
- **Development Server Memory Usage:** Zola uses around 42% less memory than Astro.



If you want to know how I calculated the data, this is the shell script I wrote in my [GitHub Gist](https://gist.github.com/sasiruLK/4aac0ef0a3748fb5663a2a71eaa38dec)



{% note(title="Note") %}
Please note that these results were generated on my personal laptop.
{% end %}



# Conclusion

I initially moved to Zola because I transitioned from being a full stack developer to focusing more on backend development with Go and Rust. This shift resulted in shorter build times and eliminated Node.js dependency issues..







