import { defineAstroPaperConfig } from "./src/types/config";

export default defineAstroPaperConfig({
  site: {
    url: "https://artukrainskiy.github.io/",
    title: "Artem Ukrainskiy",
    description:
      "Engineering notes on PHP internals and performance, with measurements.",
    author: "Artem Ukrainskiy",
    profile: "https://github.com/ArtUkrainskiy",
    ogImage: "default-og.jpg",
    lang: "en",
    timezone: "Europe/Moscow",
    dir: "ltr",
  },
  posts: {
    perPage: 10,
    perIndex: 6,
    scheduledPostMargin: 15 * 60 * 1000,
  },
  features: {
    lightAndDarkMode: true,
    dynamicOgImage: true,
    showArchives: true,
    showBackButton: true,
    editPost: { enabled: false },
    search: "pagefind",
  },
  socials: [{ name: "github", url: "https://github.com/ArtUkrainskiy" }],
  shareLinks: [
    { name: "x", url: "https://x.com/intent/post?url=" },
    { name: "telegram", url: "https://t.me/share/url?url=" },
    { name: "mail", url: "mailto:?subject=See%20this%20post&body=" },
  ],
});
