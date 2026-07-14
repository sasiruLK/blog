import type { UserConfig } from "../src/site.config";

const userConfig: UserConfig = {
  title: "Sasiru's Blog",
  description:
    "Essays, notes, and writing from Sasiru Ravihansa — software engineer writing between filter coffees and terminal windows.",

  url: "https://sasiru.lk",
  author: "Sasiru Ravihansa",

  logo: "/logo.svg",
  avatar: "/avatar.png",

  navigation: [
    { title: "Writing", url: "/posts/" },
    { title: "Archive", url: "/archive" },
    { title: "About", url: "/about" },
  ],

  footerLinks: [
    { title: "RSS", url: "/rss.xml" },
    { title: "Archive", url: "/archive" },
    { title: "GitHub", url: "https://github.com/sasiruLK" },
  ],

  social: [
    {
      title: "GitHub",
      url: "https://github.com/sasiruLK",
      icon: "github",
    },
    {
      title: "X",
      url: "https://x.com/sasiruLK",
      icon: "x",
    },
    {
      title: "LinkedIn",
      url: "https://linkedin.com/in/sasiruLK",
      icon: "linkedin",
    },
  ],

  footerCredits: "Designed for reading. Built with Astro & Lipi",

  postsPerPage: 8,
  recentPosts: 6,
  relatedPosts: 4,

  showThemeToggle: true,
  showReadingTime: true,

  heroVariant: "studio",

  annotation: "Writing between filter coffees and terminal windows.",
};

export default userConfig;