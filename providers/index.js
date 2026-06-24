// providers/index.js
// 统一 Provider 接口：新增厂商只需新增一个文件并在末尾挂到 self.<name>Provider，
// 然后在此处 REGISTRY 注册，background.js 无需修改。
//
// 加载顺序由 manifest 的 background.scripts 数组保证：
//   providers/openai.js（挂 self.openaiProvider）
//   → providers/index.js（收集到 REGISTRY）
//   → background.js（使用 getProvider）
// Chrome service worker 同样按 importScripts 顺序加载。

// 幂等守卫：避免重复加载时顶层 const/function 重复声明报错。
if (!self.aitProviders) {
  const REGISTRY = {
    openai: self.openaiProvider,
  };

  function getProvider(name) {
    const provider = REGISTRY[name];
    if (!provider) {
      throw new Error(`未知 provider: ${name}`);
    }
    return provider;
  }

  function listProviders() {
    return Object.keys(REGISTRY);
  }

  // 暴露给 background.js（非 ES module 全局共享）
  self.aitProviders = { getProvider, listProviders };
}
