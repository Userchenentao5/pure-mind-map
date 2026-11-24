# Simple Obsidian Mind Map

一款基于标准 Markdown 文件的 Obsidian 思维导图插件：新建脑图默认直接以可视化图谱打开并支持实时编辑，一键无损切换至原生 Markdown 源码模式。

## 核心特性

- **标准 `.md` 存储**：通过 Frontmatter（`mindmap-plugin: basic`）标识脑图，底层为标准标题与无序列表语法，天然兼容 Obsidian 双链、反向链接、全文检索与同步。
- **默认图谱编辑 + 一键切源码**：
  - 打开脑图文件自动进入脑图画布（`Tab` 添加子节点、`Enter` 添加兄弟节点、双击 / `F2` 编辑、拖拽调整层级、撤销重做、折叠展开）。
  - 点击右上角「源码图标」或执行命令 `切换脑图视图 / 源码模式` 即可切换回 Obsidian 原生 Markdown 编辑器，再次点击标题栏脑图图标即可切回。
- **深度融合 Obsidian 生态**：
  - 节点内支持 `[[双链笔记]]`、`[[笔记|别名]]` 点击跳转与悬停预览。
  - 节点内支持 `![[图片.png]]`、`![[图片.png|200]]` 与剪贴板直接粘贴图片到选中节点。
  - 节点支持加粗、斜体、行内代码、删除线、高亮、标签及外部链接渲染。
  - 自动跟随 Obsidian 明暗主题。
- **图片导出**：支持一键导出高清 PNG（1x/2x/3x）与自包含 SVG 图片到 Vault。
- **自定义快捷键**：支持在插件设置页自定义画布快捷键，并可通过 Obsidian 原生快捷键绑定全局命令。

## 使用注意点

1. **切换脑图 / 源码快捷键（`Ctrl+.`）与中文输入法冲突**：
   - 当光标停留在**可编辑区域**（Markdown 源码编辑器中，或脑图节点的文字输入框内）且处于**中文输入法**状态时，Windows 常见中文输入法（微软拼音、搜狗等）会在操作系统层直接拦截 `Ctrl+.` 用于「中/英文标点切换」，导致按键无法传递到 Obsidian。
   - **规避方式（任选其一）**：
     - 在 Obsidian「**设置 → 快捷键**」中搜索 `切换脑图视图 / 源码模式`，将其改绑为不与输入法冲突的快捷键（推荐 `Alt+M`、`Ctrl+M` 或 `Ctrl+Shift+M`）；
     - 切换为英文输入法状态，或先按 `Esc` 退出节点文字编辑后再按 `Ctrl+.`；
     - 在 Windows 输入法设置中关闭「`Ctrl+.` 切换中英文标点」热键；
     - 直接点击页面右上角的切换图标完成视图切换。
2. **文件识别机制**：
   - 只有 YAML Frontmatter 包含 `mindmap-plugin: basic` 的 `.md` 文件才会默认自动以脑图视图打开；普通 Markdown 笔记可通过命令面板「将当前笔记转为脑图并打开」一键转换。

## 开发与本地联调

1. 安装依赖：
   ```bash
   npm install
   ```
2. 配置本地 Obsidian 测试库自动同步（复制 `.env.example` 为 `.env`）：
   ```env
   OBSIDIAN_VAULT_PATH=D:\你的Obsidian库路径
   ```
   （也可以直接指定 `OBSIDIAN_PLUGIN_DIR` 为目标插件目录。）
3. 启动监听构建（每次保存自动编译并同步 `main.js`、`styles.css`、`manifest.json` 到测试库）：
   ```bash
   npm run dev
   ```
4. 生产构建与测试：
   ```bash
   npm test
   npm run build
   ```
5. 在 Obsidian 中打开「设置 → 第三方插件」，刷新并启用 **Simple Obsidian Mind Map** 即可体验。
