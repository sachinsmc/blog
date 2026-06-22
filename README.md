# sachinsmc.me

Source for my personal blog at [sachinsmc.me](https://sachinsmc.me), built with
[Hugo](https://gohugo.io) and the [PaperMod](https://github.com/adityatelange/hugo-PaperMod)
theme. I work across the stack in Go, Node.js, and Python, and write about
engineering, AI/ML, cloud, security, and blockchain.

## Stack

- **Hugo** (extended) with the **PaperMod** theme (vendored as a git submodule)
- Posts are **page bundles** under `content/blog/<slug>/` (Markdown + images +
  diagram sources alongside)
- Deployed to **GitHub Pages** via `.github/workflows/hugo.yml`

## Local development

```sh
git clone --recurse-submodules https://github.com/sachinsmc/blog
cd blog
hugo server -D
```

Then open <http://localhost:1313>. The `-D` flag includes drafts.

If you cloned without `--recurse-submodules`, pull the theme:

```sh
git submodule update --init --recursive
```

## Writing a post

Each post is its own folder so its assets live next to it:

```
content/blog/my-post/
  index.md          # front matter (TOML) + body
  diagram.svg       # images / diagrams referenced from index.md
```

Reference bundle images with the figure shortcode, e.g.
`{{</* figure src="diagram.svg" alt="..." caption="..." */>}}`.

House style: no em dashes, prefer real code and real numbers over hand-waving.

## Diagrams

Diagrams are generated from a single source so the editable and embeddable
versions always match. Running:

```sh
node gen-diagrams.mjs
```

writes, for each diagram, both an editable `.excalidraw` scene (open it at
[excalidraw.com](https://excalidraw.com)) and a rendered `.svg` into the relevant
post bundle. Edit the layout in `gen-diagrams.mjs` and re-run to regenerate both.

## Build for production

```sh
hugo --minify
```

Output lands in `public/` (git-ignored; CI rebuilds it on deploy).

## Layout

```
content/        posts and pages (about, search)
hugo.yaml       site config (menu, social icons, params)
themes/PaperMod git submodule (theme)
gen-diagrams.mjs diagram generator (.excalidraw + .svg)
.github/        Pages deploy workflow
```
