App({
  onLaunch() {
    // Local Go server mode: no app-wide setup is required.
  },

  globalData: {
    userLocation: null   // cached after first getLocation call
  }
});
