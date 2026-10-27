/** 动效模块之间共享的运行时状态（仅客户端使用）。 */
export const motionState = {
  /** 归一化后的滚动速度，-1…1，由 SiteChrome 更新、HeroCanvas 读取。 */
  scrollVelocity: 0,
  /** 首屏涂抹着色器的“浮现”进度：0 = 完全涂抹，1 = 清晰。 */
  reveal: 0,
};
