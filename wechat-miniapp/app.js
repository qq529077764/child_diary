App({
  onLaunch() {
    // 测试版不继承旧端口、旧日记或旧会话状态。
    wx.clearStorageSync();
  },
  globalData: {}
});
