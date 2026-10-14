# 界面风格的实现依据

EchoMark 是静态网页。本项目将相关设计规范映射为 HTML/CSS 组件，不运行 Android Compose 或 MiuiX 原生组件。切换风格不改变正文索引、文件排版或语音流程。原版是首次使用的默认风格。

## Material You / Material 3

- 使用官方 Material Color Utilities 0.3.0 的 HCT、TonalSpot 算法，以用户选择的强调色生成浅色主题。
- 区分 primary、onPrimary、primaryContainer、surfaceContainer、outline 等语义角色；侧栏、正文、选项和操作按钮有各自的色彩层级。
- 使用大圆角工作台、圆润折叠卡片、胶囊主按钮，标题与正文按不同字号和字重组织。
- 按钮和选项有悬停状态层、键盘焦点边框和至少 48px 的主要触控区域。
- 用户的正文颜色和标记颜色继续作用于阅读内容；界面色阶由强调色生成。

依据：[色彩角色](https://m3.material.io/m3/pages/color-roles?s=m3)、[字体应用](https://m3.material.io/styles/typography/applying-type)、[Material 3 主题开发](https://developer.android.com/codelabs/m3-design-theming)、[官方色彩算法](https://github.com/material-foundation/material-color-utilities)。

## MiuiX

- 控件与阅读区域分为独立的轻量卡片组；较强的标题字重与充足行高形成清晰层级。
- 卡片采用 16px 圆角，支持时渐进增强为 squircle；主要操作、选择项和输入框统一形状与间距。
- 主操作强调色填充，次要操作使用浅色容器；点击时轻微缩放模拟官方文档中的按压反馈，减少动态效果偏好时关闭动画。
- 紧凑的折叠设置、52px 输入框和清晰选中状态，使鼠标和触控都容易使用。

依据：[MiuiX 官方项目](https://github.com/compose-miuix-ui/miuix)、[主题](https://github.com/compose-miuix-ui/miuix/blob/main/docs/guide/theme.md)、[卡片](https://github.com/compose-miuix-ui/miuix/blob/main/docs/components/card.md)、[按钮](https://github.com/compose-miuix-ui/miuix/blob/main/docs/components/button.md)。

## 代码位置

- `styles.css`：原版样式、正文布局、标记样式和共用组件。
- `themes.css`：Material You 与 MiuiX 的整套界面覆盖及移动端布局。
- `theme-colors.js`：Material 3 语义色阶生成。
- `app.js`：选项切换与浏览器偏好保存。

所有风格均支持整页展开和独立阅读窗；不把 PDF 页面背景上的框线计入文字索引。
