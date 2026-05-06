'use strict';

const api = require('../../utils/api');
const { moodColor, moodColorAlpha, MOOD_OPTIONS } = require('../../utils/mood-color');
const history = require('../../utils/history');
const { generateShareCard } = require('../../utils/share');

const FALLBACK_LAT    = 39.9042;
const FALLBACK_LNG    = 116.4074;
const VIEWPORT_DELTA  = 0.15;
const MIN_COUNT       = 2;
const STATS_REFRESH_MS = 60000;   // 统计条每 60s 刷新一次
const HEATMAP_REFRESH_MS = 5000;  // 本地服务模式下轮询热力图

// ─────────────────────────────────────────────────────────────────────────────

Page({

  // ── 初始数据 ──────────────────────────────────────────────────────────────

  data: {
    latitude:  FALLBACK_LAT,
    longitude: FALLBACK_LNG,
    scale:     13,

    circles:  [],
    markers:  [],

    tapLocation: null,

    // 提交面板
    showSubmit:   false,
    selectedMood: null,
    submitting:   false,
    moodOptions:  MOOD_OPTIONS,

    // 统计面板
    showStats:    false,
    statsLoading: false,
    stats: {
      avgMood: null, avgColor: '#999',
      count: 0, dist: [], entries: [],
    },

    // 全国统计条
    globalStats: null,      // null = 加载中
    tickerText:  '',        // 拼好的滚动文字

    // 反馈卡片（提交后展示）
    showFeedback:  false,
    feedback: {
      mood:        null,
      color:       '#7E57C2',
      title:       '',
      city:        '',
      cityAvg:     null,
      percentile:  null,
      streak:      0,
      milestoneMsg:'',
      totalCount:  0,
      sharing:     false,
    },

    // 城市排行榜面板
    showLeaderboard: false,
    leaderboard: [],         // [{ city, avg, count, rank, highlight }]
    lastCity:    '',

    // 首次引导
    showOnboarding: false,

    // Toast
    toast: { show: false, msg: '', type: 'success' },

    loading: true,
    pinIconPath: '',
  },

  _mapCtx:        null,
  _statsTimer:    null,
  _heatmapTimer:  null,
  _heatmapBboxKey:'',

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  onLoad() {
    this._mapCtx = wx.createMapContext('map', this);
    const seen = wx.getStorageSync('onboarded');
    if (!seen) this.setData({ showOnboarding: true });
  },

  onReady() {
    this._generatePinIcon().then(path => {
      if (path) this.setData({ pinIconPath: path });
    });
    this._initLocation();
    this._loadGlobalStats();
    this._statsTimer = setInterval(() => this._loadGlobalStats(), STATS_REFRESH_MS);
  },

  onUnload() {
    this._stopHeatmapPolling();
    if (this._statsTimer) clearInterval(this._statsTimer);
  },

  // ── 引导页 ────────────────────────────────────────────────────────────────

  dismissOnboarding() {
    wx.setStorageSync('onboarded', true);
    this.setData({ showOnboarding: false });
  },

  // ── 全国统计条 ────────────────────────────────────────────────────────────

  async _loadGlobalStats() {
    try {
      const { result } = await api.getStats();
      if (!result.ok || result.empty) return;

      const s = result;
      const parts = [
        `🌏 全国心情  ${s.avgMood} / 10`,
        `📍 来自 ${s.cityCount} 个城市的 ${s.totalCount} 条记录`,
        s.happiest   ? `😊 最开心城市：${s.happiest}`   : null,
        s.mostActive ? `🏆 最活跃城市：${s.mostActive}` : null,
        `⚡ 实时速度：${s.speed} 条 / 小时`,
        `🔒 无需注册 · 完全匿名 · 位置已模糊`,
      ].filter(Boolean).join('   ·   ');

      this.setData({
        globalStats: result,
        tickerText:  parts + '     ' + parts,
      });
    } catch (e) {
      console.warn('[stats]', e);
    }
  },

  // ── 生成图钉图标 ──────────────────────────────────────────────────────────

  _generatePinIcon() {
    return new Promise(resolve => {
      const query = wx.createSelectorQuery().in(this);
      query.select('#pin-canvas').fields({ node: true }).exec(res => {
        if (!res[0] || !res[0].node) { resolve(''); return; }

        const canvas = res[0].node;
        const dpr    = wx.getSystemInfoSync().pixelRatio;
        const W = 32, H = 42;
        canvas.width  = W * dpr;
        canvas.height = H * dpr;

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        ctx.beginPath();
        ctx.arc(W / 2, 14, 13, 0, 2 * Math.PI);
        ctx.fillStyle = '#1a1a2e';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(W / 2 - 6, 24);
        ctx.lineTo(W / 2 + 6, 24);
        ctx.lineTo(W / 2,     40);
        ctx.closePath();
        ctx.fillStyle = '#1a1a2e';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(W / 2, 14, 4, 0, 2 * Math.PI);
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        wx.canvasToTempFilePath({
          canvas,
          success: r => resolve(r.tempFilePath),
          fail:    () => resolve(''),
        }, this);
      });
    });
  },

  // ── 定位 ──────────────────────────────────────────────────────────────────

  async _initLocation() {
    try {
      const { latitude, longitude } = await this._requestLocation();
      getApp().globalData.userLocation = { latitude, longitude };
      this.setData({ latitude, longitude, loading: false });
      this._startHeatmapPolling(latitude, longitude);
    } catch {
      this.setData({ loading: false });
      this._startHeatmapPolling(FALLBACK_LAT, FALLBACK_LNG);
    }
  },

  _requestLocation() {
    return new Promise((resolve, reject) =>
      wx.getLocation({ type: 'gcj02', success: resolve, fail: reject })
    );
  },

  locateUser() {
    this._mapCtx.moveToLocation();
  },

  // ── 热力图轮询 ────────────────────────────────────────────────────────────

  _startHeatmapPolling(lat, lng) {
    const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    if (this._heatmapBboxKey === key) return;
    this._heatmapBboxKey = key;
    this._stopHeatmapPolling();
    this._fetchHeatmap(lat, lng);
    this._heatmapTimer = setInterval(() => this._fetchHeatmap(lat, lng), HEATMAP_REFRESH_MS);
  },

  _stopHeatmapPolling() {
    if (this._heatmapTimer) {
      clearInterval(this._heatmapTimer);
      this._heatmapTimer = null;
    }
  },

  async _fetchHeatmap(lat, lng) {
    const sw = { lat: lat - VIEWPORT_DELTA, lng: lng - VIEWPORT_DELTA };
    const ne = { lat: lat + VIEWPORT_DELTA, lng: lng + VIEWPORT_DELTA };
    try {
      const { result } = await api.getHeatmap(sw, ne, MIN_COUNT);
      if (result.ok) this._renderCells(result.cells);
    } catch {}
  },

  // ── 渲染热力圈 ────────────────────────────────────────────────────────────

  _renderCells(cells) {
    if (!cells || cells.length === 0) { this.setData({ circles: [] }); return; }
    const max = cells.reduce((m, c) => Math.max(m, c.count), 1);
    this.setData({
      circles: cells.map(cell => ({
        latitude:    cell.lat,
        longitude:   cell.lng,
        radius:      lerp(400, 2500, cell.count / max),
        color:       moodColorAlpha(cell.avg_mood, 0.75),
        fillColor:   moodColorAlpha(cell.avg_mood, 0.20),
        strokeWidth: 2,
      })),
    });
  },

  // ── 地图事件 ──────────────────────────────────────────────────────────────

  onMapTap(e) {
    const { latitude, longitude } = e.detail;
    this.setData({
      tapLocation:  { latitude, longitude },
      markers: [{
        id: 999, latitude, longitude,
        iconPath: this.data.pinIconPath,
        width: 32, height: 42,
        anchor: { x: 0.5, y: 1.0 },
      }],
      showSubmit:   true,
      showStats:    false,
      showLeaderboard: false,
      selectedMood: null,
    });
  },

  onRegionChange(e) {
    if (e.type !== 'end') return;
    this._mapCtx.getCenterLocation({
      success: ({ latitude, longitude }) => {
        this.setData({ latitude, longitude });
        this._startHeatmapPolling(latitude, longitude);
      },
    });
  },

  // ── 提交面板 ──────────────────────────────────────────────────────────────

  closeSubmit() {
    this.setData({ showSubmit: false, selectedMood: null, markers: [], tapLocation: null });
  },

  selectMood(e) {
    this.setData({ selectedMood: Number(e.currentTarget.dataset.value) });
  },

  async submitMood() {
    const { selectedMood, tapLocation } = this.data;
    if (!selectedMood || !tapLocation || this.data.submitting) return;
    this.setData({ submitting: true });

    // 并行：提交心情 + 获取附近数据（用于百分位）
    const submitPromise = api.submitMood(
      tapLocation.latitude, tapLocation.longitude, selectedMood
    );
    const nearbyPromise = api.getNearbyMoods(
      tapLocation.latitude, tapLocation.longitude, 5000
    ).catch(() => null);

    try {
      const { result } = await submitPromise;

      if (result.ok) {
        // 保存本地历史，获取 streak
        const { streak, milestoneMsg } = history.save(selectedMood, result.city || '');

        // 城市均值（来自附近数据，异步填充）
        const globalStats = this.data.globalStats;
        const totalCount  = globalStats ? globalStats.totalCount : 0;

        const CARD_TITLES = [
          '今天很难。','今天很难。','在撑着。','在撑着。','及格了。',
          '还不错。','还不错。','今天你在发光。','今天你在发光。','今天你在发光。',
        ];

        const color = moodColor(selectedMood);

        this.setData({
          showSubmit:   false,
          markers:      [],
          selectedMood: null,
          showFeedback: true,
          feedback: {
            mood:         selectedMood,
            color,
            title:        CARD_TITLES[selectedMood - 1],
            city:         result.city || '',
            cityAvg:      null,
            percentile:   null,
            streak,
            milestoneMsg,
            totalCount,
            sharing:      false,
          },
        });
        this._fetchHeatmap(tapLocation.latitude, tapLocation.longitude);

        // 附近数据回来后异步更新百分位和城市均值
        nearbyPromise.then(nearbyRes => {
          if (!nearbyRes || !nearbyRes.result || !nearbyRes.result.ok) return;
          const r = nearbyRes.result;
          if (r.count === 0) return;

          const entries  = r.entries || [];
          const cityName = result.city || '';

          // 城市均值：同城条目
          const cityEntries = cityName
            ? entries.filter(e => e.city === cityName)
            : [];
          const cityAvg = cityEntries.length >= 2
            ? Math.round(cityEntries.reduce((s, e) => s + e.mood, 0) / cityEntries.length * 10) / 10
            : null;

          // 百分位：附近中心情低于我的比例
          const below = entries.filter(e => e.mood < selectedMood).length;
          const percentile = r.count > 1
            ? Math.round((below / (r.count)) * 100)
            : null;

          this.setData({
            'feedback.cityAvg':    cityAvg,
            'feedback.percentile': percentile,
          });
        });

      } else {
        const MSGS = {
          RATE_LIMITED:   '请稍后再提交',
          INVALID_MOOD:   '心情值无效',
          INVALID_COORDS: '位置超出范围',
        };
        this._showToast(MSGS[result.code] || '提交失败，请重试', 'error');
        this.setData({ showSubmit: false, markers: [], selectedMood: null });
      }
    } catch {
      this._showToast('网络错误，请重试', 'error');
    } finally {
      this.setData({ submitting: false });
    }
  },

  // ── 反馈卡片 ──────────────────────────────────────────────────────────────

  closeFeedback() {
    this.setData({ showFeedback: false });
  },

  async shareFeedback() {
    if (this.data.feedback.sharing) return;
    this.setData({ 'feedback.sharing': true });

    const { feedback, globalStats } = this.data;
    try {
      const path = await generateShareCard(this, {
        mood:       feedback.mood,
        city:       feedback.city,
        cityAvg:    feedback.cityAvg,
        percentile: feedback.percentile,
        streak:     feedback.streak,
        totalCount: globalStats ? globalStats.totalCount : 0,
      });

      if (!path) { this._showToast('生成图片失败', 'error'); return; }

      wx.saveImageToPhotosAlbum({
        filePath: path,
        success:  () => this._showToast('已保存到相册 📸', 'success'),
        fail:     () => this._showToast('请授权相册权限', 'error'),
      });
    } catch {
      this._showToast('生成失败，请重试', 'error');
    } finally {
      this.setData({ 'feedback.sharing': false });
    }
  },

  // ── 统计面板 ──────────────────────────────────────────────────────────────

  async openStats() {
    const { latitude, longitude } = this.data;
    this.setData({ showStats: true, showSubmit: false, showLeaderboard: false, statsLoading: true });
    try {
      const { result } = await api.getNearbyMoods(latitude, longitude, 5000);
      this.setData({
        statsLoading: false,
        stats: result.ok && result.count > 0
          ? buildStats(result)
          : { avgMood: null, avgColor: '#ccc', count: 0, dist: [], entries: [] },
      });
    } catch {
      this.setData({ statsLoading: false });
      this._showToast('加载失败', 'error');
    }
  },

  closeStats() {
    this.setData({ showStats: false });
  },

  // ── 城市排行榜 ────────────────────────────────────────────────────────────

  openLeaderboard() {
    const { globalStats } = this.data;
    const lastCity = history.getLastCity();

    if (!globalStats || !globalStats.cityRankings || globalStats.cityRankings.length === 0) {
      this._showToast('数据加载中，请稍后', 'error');
      return;
    }

    const leaderboard = globalStats.cityRankings.map((item, i) => ({
      rank:      i + 1,
      city:      item.city,
      avg:       item.avg,
      count:     item.count,
      color:     moodColor(item.avg),
      highlight: item.city === lastCity,
    }));

    this.setData({
      showLeaderboard: true,
      showStats:       false,
      showSubmit:      false,
      leaderboard,
      lastCity,
    });
  },

  closeLeaderboard() {
    this.setData({ showLeaderboard: false });
  },

  // ── Toast ─────────────────────────────────────────────────────────────────

  _showToast(msg, type = 'success') {
    this.setData({ toast: { show: true, msg, type } });
    setTimeout(() => this.setData({ toast: { show: false, msg: '', type } }), 2500);
  },
});

// ── 纯函数 ────────────────────────────────────────────────────────────────────

function buildStats(result) {
  const entries = result.entries;
  const tally   = Array(10).fill(0);
  entries.forEach(e => { tally[e.mood - 1]++; });
  const total   = entries.length;
  const avgMood = total > 0 ? entries.reduce((s, e) => s + e.mood, 0) / total : null;

  return {
    avgMood:  avgMood !== null ? Math.round(avgMood * 10) / 10 : null,
    avgColor: avgMood !== null ? moodColor(avgMood) : '#999',
    count:    total,
    dist: tally.map((count, i) => ({
      mood: i + 1, count,
      pct:  total > 0 ? Math.round((count / total) * 100) : 0,
      color: moodColor(i + 1),
    })),
    entries: entries.slice(0, 20).map(e => ({
      mood:    e.mood,
      color:   moodColor(e.mood),
      emoji:   MOOD_OPTIONS[e.mood - 1].emoji,
      timeAgo: timeAgo(e.ts),
      distKm:  (e.dist_m / 1000).toFixed(1),
    })),
  };
}

function timeAgo(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60)   return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  return `${Math.floor(s / 3600)} 小时前`;
}

function lerp(a, b, t) {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}
