# 界面风格的实现依据

EchoMark 是静态网页。本项目将相关设计规范映射为 HTML/CSS 组件，不运行 Android Compose 或 MiuiX 原生组件。切换风格不改变正文索引、文件排版或语音流程。原版是首次使用的默认风格。

三套风格采用一致的尺寸层级。两套可选主题的宽度、字号、按钮和工具栏尺寸集中在 `themes.css` 的共用规则中，以原版为基准；仅通过色彩、形状、卡片与反馈区分风格。桌面侧栏 320px，窄屏 260px，手机单列；标题 36px、面板标题 16px、按钮 42px，手机操作按钮 46px。正文沿用同一字号设置。原版基础样式文件沿用 v0.4.0。

## Material You / Material 3

- 使用官方 Material Color Utilities 0.3.0 的 HCT、TonalSpot 算法，以用户选择的强调色生成浅色主题。
- 区分 primary、onPrimary、primaryContainer、surfaceContainer、outline 等语义角色；侧栏、正文、选项和操作按钮有各自的色彩层级。
- 使用大圆角工作台、圆润折叠卡片、胶囊主按钮，标题与正文按不同字号和字重组织。
- 按钮和选项有悬停状态层、键盘焦点边框；尺寸以网页三种风格的一致性为准，手机扩大主要操作的触控区域。
- 用户的正文颜色和标记颜色继续作用于阅读内容；界面色阶由强调色生成。

依据：[色彩角色](https://m3.material.io/m3/pages/color-roles?s=m3)、[字体应用](https://m3.material.io/styles/typography/applying-type)、[Material 3 主题开发](https://developer.android.com/codelabs/m3-design-theming)、[官方色彩算法](https://github.com/material-foundation/material-color-utilities)。

## MiuiX

- 控件与阅读区域分为独立的轻量卡片组；较强的标题字重与充足行高形成清晰层级。
- 卡片采用 16px 圆角，支持时渐进增强为 squircle；主要操作、选择项和输入框统一形状与间距。
- 主操作强调色填充，次要操作使用浅色容器；点击时轻微缩放模拟官方文档中的按压反馈，减少动态效果偏好时关闭动画。
- 紧凑的折叠设置、桌面 37px / 手机 44px 输入框和清晰选中状态，使鼠标和触控都容易使用。

依据：[MiuiX 官方项目](https://github.com/compose-miuix-ui/miuix)、[主题](https://github.com/compose-miuix-ui/miuix/blob/main/docs/guide/theme.md)、[卡片](https://github.com/compose-miuix-ui/miuix/blob/main/docs/components/card.md)、[按钮](https://github.com/compose-miuix-ui/miuix/blob/main/docs/components/button.md)。

## 代码位置

- `styles.css`：原版样式、正文布局、标记样式和共用组件。
- `themes.css`：Material You 与 MiuiX 的整套界面覆盖及移动端布局。
- `theme-colors.js`：Material 3 语义色阶生成。
- `app.js`：选项切换与浏览器偏好保存。

所有风格均支持整页展开和独立阅读窗；不把 PDF 页面背景上的框线计入文字索引。
