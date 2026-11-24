# Pure Mind Map

Create and edit interactive mind maps backed by standard Markdown (`.md`) files in Obsidian, with one-click switching between visual mind map editing and native Markdown source mode.

[中文说明](#中文说明)

## Features

- **Standard Markdown storage**: Mind map notes are plain `.md` files identified by YAML frontmatter (`mindmap-plugin: basic`), using standard headings (`#`, `##`) and nested lists (`-`). Fully compatible with Obsidian backlinks, graph view, search, tags, and sync.
- **Default mind map view & instant source switch**:
  - Opening a mind map note automatically launches the interactive mind map canvas (`Tab` for child node, `Enter` for sibling, double-click / `F2` to edit, drag-and-drop reparenting, undo/redo, collapse/expand, and 4 layout directions).
  - Switch between the mind map canvas and Obsidian's native Markdown editor with one click (header / toolbar button) or via the command **Toggle Mind Map / Source Mode**.
- **Deep Obsidian integration**:
  - **Inline `[[wikilink]]` & `![[embed]]` completion**: Type `[[` or `![[` inside any node to search and insert vault notes or images with keyboard navigation.
  - **Clickable links & hover preview**: Click wikilinks to open notes (`Ctrl/Cmd + Click` in a new tab) and hover for native page previews.
  - **Rich inline text editing**: Right-click inside an active node editor for links, image embeds, bold/italic/strikethrough/highlight/inline code, and clipboard actions. Paste clipboard images directly onto a selected node (`Ctrl/Cmd + V`).
  - **Automatic theme sync**: Follows Obsidian's light and dark themes automatically.
- **Multi-format export**: Export mind maps as **PNG**, **SVG**, **JPEG**, or **WebP** with selectable resolution (`1x`/`2x`/`3x`) to any vault folder or local disk directory.

## Installation

### From Obsidian Community Plugins (once approved)
1. Open **Settings → Community plugins → Browse**.
2. Search for **Pure Mind Map**, then click **Install** and **Enable**.

### Early access via BRAT
1. Install the **BRAT** plugin from Community Plugins.
2. Open BRAT settings → **Add Beta plugin** and enter `Userchenentao5/simple-obsidian-mind-map`.

### Manual installation
Download `main.js`, `manifest.json`, and `styles.css` from the latest [GitHub Release](https://github.com/Userchenentao5/simple-obsidian-mind-map/releases) into `<vault>/.obsidian/plugins/pure-mind-map/` and enable **Pure Mind Map** in Obsidian settings.

## Usage Notes

- **View-switch shortcut & Chinese IME**: You can bind a custom hotkey to **Toggle Mind Map / Source Mode** in **Settings → Hotkeys** (e.g., `Alt+M` or `Ctrl+Shift+M`). On Windows with Chinese IME active inside an editable field, `Ctrl+.` may be intercepted by the OS IME for punctuation toggling; prefer `Alt+M` or `Ctrl+Shift+M`, or click the header toggle button.
- **Converting existing notes**: Run the command **Convert current note to Mind Map** on any existing Markdown note to add the `mindmap-plugin: basic` frontmatter and open it as a mind map.

---

## 中文说明

**Pure Mind Map** 是一款基于标准 Markdown（`.md`）文件的 Obsidian 思维导图插件：新建脑图默认直接以可视化图谱打开并支持实时编辑，可一键无损切换至原生 Markdown 源码模式。

### 核心特性

- **标准 `.md` 存储**：通过 YAML Frontmatter（`mindmap-plugin: basic`）标识脑图，底层采用标准标题与无序列表语法，天然兼容 Obsidian 双链、反向链接、关系图谱、全文检索与同步。
- **默认图谱编辑 + 一键切源码**：
  - 打开脑图文件自动进入脑图画布（`Tab` 添加子节点、`Enter` 添加兄弟节点、双击 / `F2` 编辑、拖拽调整层级、撤销重做、折叠展开、4 种布局方向）。
  - 点击标题栏/工具栏切换图标，或在命令面板运行 `切换脑图视图 / 源码模式` 即可在脑图与原生 Markdown 编辑器间无感切换。
- **深度融合 Obsidian 生态**：
  - 节点编辑时输入 `[[` 或 `![[` 实时弹出库内笔记/图片补全浮窗；右键节点文本支持格式设置、插入双链/外链/图片及剪贴板操作。
  - 支持双链点击跳转与原生悬停预览、剪贴板直接粘贴图片到节点，并自动跟随 Obsidian 明暗主题。
- **多格式、可选目录导出**：点击下载按钮支持导出为 **PNG / SVG / JPEG / WebP**，可选择保存到库内任意目录或通过系统「另存为」保存到本地磁盘任意文件夹。

### 使用注意点

1. **视图切换快捷键与中文输入法说明**：可在 Obsidian「**设置 → 快捷键**」中搜索 `切换脑图视图 / 源码模式` 绑定顺手的快捷键（推荐 `Alt+M` 或 `Ctrl+Shift+M`）。若使用 `Ctrl+.`，在 Windows 中文输入法且光标位于源码或节点编辑框内时，系统输入法会先拦截 `Ctrl+.` 用于切换标点，建议改绑其他快捷键或直接点击页面右上角图标切换。
2. **文件识别机制**：只有 YAML Frontmatter 包含 `mindmap-plugin: basic` 的 `.md` 文件会默认自动以脑图视图打开；普通笔记可通过命令面板「将当前笔记转为脑图并打开」一键转换。

### 本地开发与测试

```bash
npm install
npm run lint
npm test
npm run build
```

复制 `.env.example` 为 `.env` 并填写 `OBSIDIAN_VAULT_PATH=<你的库路径>` 后，运行 `npm run dev` 或 `npm run build` 会自动将 `main.js`、`styles.css`、`manifest.json` 同步到 `<vault>/.obsidian/plugins/pure-mind-map/`。
