# 第三方组件

- `vendor/material-colors.mjs`：官方 `@material/material-color-utilities` 0.3.0，Apache-2.0，完整许可见相邻 `material-colors.LICENSE`。用于本机生成 Material 3 主题，来源见 [官方仓库](https://github.com/material-foundation/material-color-utilities)。

- `vendor/pinyin-pro.js`：pinyin-pro 3.29.5，MIT 许可，完整许可见相邻的 `pinyin-pro.LICENSE`。用于本机中文拼音匹配，不发送原文。
- 可选本机识别运行库：Hugging Face Transformers.js 3.8.1，Apache-2.0，[源码与许可](https://github.com/huggingface/transformers.js/tree/3.8.1)。用户启用后才从 jsDelivr 加载。
- 可选本机模型：[onnx-community/whisper-tiny](https://huggingface.co/onnx-community/whisper-tiny)，固定修订 `ff4177021cc41f7db950912b73ea4fdf7d01d8e7`，由 OpenAI Whisper Tiny 转换为 ONNX。模型及其许可与项目代码分别管理，详情见模型仓库和 [Whisper 原始仓库](https://github.com/openai/whisper)。

本机模型首次使用需要联网下载与缓存；转写音频只传入浏览器的本地 Worker，不发往上述下载服务。浏览器内置识别服务的音频处理方式由浏览器平台决定。
