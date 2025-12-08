// src/lib/seo.ts
export function setPageMeta(options: {
  title?: string;
  description?: string;
}) {
  if (typeof document === "undefined") return;

  const { title, description } = options;

  if (title) {
    document.title = title;
  }

  if (description) {
    let tag = document.querySelector(
      'meta[name="description"]'
    ) as HTMLMetaElement | null;

    if (!tag) {
      tag = document.createElement("meta");
      tag.name = "description";
      document.head.appendChild(tag);
    }

    tag.content = description;
  }
}