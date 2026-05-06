/**
 * API helpers — local Go server wrappers.
 *
 * In WeChat DevTools, enable:
 * "不校验合法域名、web-view、TLS 版本以及 HTTPS 证书".
 *
 * For phone debugging, replace 127.0.0.1 with your computer's LAN IP.
 */

const LOCAL_API_BASE = 'http://127.0.0.1:8080';
const CLIENT_ID_KEY = 'local_client_id';

function request(path, data = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${LOCAL_API_BASE}${path}`,
      method,
      data,
      header: {
        'content-type': 'application/json',
        'X-Mood-Client': getClientId(),
      },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      },
      fail: reject,
    });
  });
}

function getClientId() {
  try {
    let id = wx.getStorageSync(CLIENT_ID_KEY);
    if (!id) {
      id = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      wx.setStorageSync(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    return 'local-dev';
  }
}

/**
 * Submit a mood entry.
 * @param {number} lat   Raw latitude from wx.getLocation (GCJ-02)
 * @param {number} lng   Raw longitude from wx.getLocation (GCJ-02)
 * @param {number} mood  Integer 1–10
 * @returns {Promise<{result: {ok, cell?, code?, msg?}}>}
 */
function submitMood(lat, lng, mood) {
  return request('/api/submitMood', { lat, lng, mood });
}

/**
 * Fetch aggregated heatmap cells for a map viewport.
 * @param {{lat, lng}} sw  South-west corner of viewport
 * @param {{lat, lng}} ne  North-east corner of viewport
 * @param {number} minCount  Filter cells with fewer submissions (noise gate)
 * @returns {Promise<{result: {ok, cells, generated_at}}>}
 */
function getHeatmap(sw, ne, minCount = 2) {
  return request('/api/getHeatmap', { sw, ne, min_count: minCount });
}

/**
 * Fetch individual mood entries near a point.
 * @param {number} lat
 * @param {number} lng
 * @param {number} radius  Metres (default 3000, max 20000)
 * @returns {Promise<{result: {ok, entries, count}}>}
 */
function getNearbyMoods(lat, lng, radius = 3000) {
  return request('/api/getNearbyMoods', { lat, lng, radius });
}

/**
 * 获取全国实时统计数据（最近200条）
 * @returns {Promise<{result: {ok, avgMood, cityCount, happiest, mostActive, speed, totalCount}}>}
 */
function getStats() {
  return request('/api/getStats', {}, 'GET');
}

module.exports = { submitMood, getHeatmap, getNearbyMoods, getStats };
