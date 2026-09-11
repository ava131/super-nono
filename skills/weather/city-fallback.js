/**
 * 常用城市的经纬度兜底表。
 *
 * 为什么需要它：Open-Meteo 的地理编码对**中文城市名**的识别率需要实测，
 * 万一"上海"查不到，总不能回答"我查不到上海在哪"。
 * 命中这张表就直接用，不走网络（顺带还省一次请求）。
 *
 * 表里没写到的城市仍然会去走地理编码。
 */

/** @type {Record<string, { latitude: number, longitude: number, label: string }>} */
export const CITY_FALLBACK = {
  北京: { latitude: 39.9042, longitude: 116.4074, label: '北京' },
  上海: { latitude: 31.2304, longitude: 121.4737, label: '上海' },
  广州: { latitude: 23.1291, longitude: 113.2644, label: '广州' },
  深圳: { latitude: 22.5431, longitude: 114.0579, label: '深圳' },
  杭州: { latitude: 30.2741, longitude: 120.1551, label: '杭州' },
  南京: { latitude: 32.0603, longitude: 118.7969, label: '南京' },
  苏州: { latitude: 31.2989, longitude: 120.5853, label: '苏州' },
  成都: { latitude: 30.5728, longitude: 104.0668, label: '成都' },
  重庆: { latitude: 29.563, longitude: 106.5516, label: '重庆' },
  武汉: { latitude: 30.5928, longitude: 114.3055, label: '武汉' },
  西安: { latitude: 34.3416, longitude: 108.9398, label: '西安' },
  天津: { latitude: 39.3434, longitude: 117.3616, label: '天津' },
  长沙: { latitude: 28.2282, longitude: 112.9388, label: '长沙' },
  郑州: { latitude: 34.7466, longitude: 113.6254, label: '郑州' },
  青岛: { latitude: 36.0671, longitude: 120.3826, label: '青岛' },
  济南: { latitude: 36.6512, longitude: 117.1201, label: '济南' },
  沈阳: { latitude: 41.8057, longitude: 123.4315, label: '沈阳' },
  哈尔滨: { latitude: 45.8038, longitude: 126.535, label: '哈尔滨' },
  长春: { latitude: 43.8171, longitude: 125.3235, label: '长春' },
  大连: { latitude: 38.914, longitude: 121.6147, label: '大连' },
  福州: { latitude: 26.0745, longitude: 119.2965, label: '福州' },
  厦门: { latitude: 24.4798, longitude: 118.0894, label: '厦门' },
  合肥: { latitude: 31.8206, longitude: 117.2272, label: '合肥' },
  昆明: { latitude: 25.0389, longitude: 102.7183, label: '昆明' },
  贵阳: { latitude: 26.647, longitude: 106.6302, label: '贵阳' },
  南宁: { latitude: 22.817, longitude: 108.3665, label: '南宁' },
  海口: { latitude: 20.0444, longitude: 110.1999, label: '海口' },
  三亚: { latitude: 18.2528, longitude: 109.5119, label: '三亚' },
  兰州: { latitude: 36.0611, longitude: 103.8343, label: '兰州' },
  西宁: { latitude: 36.6171, longitude: 101.7782, label: '西宁' },
  银川: { latitude: 38.4872, longitude: 106.2309, label: '银川' },
  乌鲁木齐: { latitude: 43.8256, longitude: 87.6168, label: '乌鲁木齐' },
  拉萨: { latitude: 29.65, longitude: 91.1, label: '拉萨' },
  呼和浩特: { latitude: 40.8414, longitude: 111.7519, label: '呼和浩特' },
  太原: { latitude: 37.8706, longitude: 112.5489, label: '太原' },
  石家庄: { latitude: 38.0428, longitude: 114.5149, label: '石家庄' },
  南昌: { latitude: 28.682, longitude: 115.8579, label: '南昌' },
  宁波: { latitude: 29.8683, longitude: 121.544, label: '宁波' },
  温州: { latitude: 27.9938, longitude: 120.6994, label: '温州' },
  无锡: { latitude: 31.4912, longitude: 120.3119, label: '无锡' },
  佛山: { latitude: 23.0218, longitude: 113.1219, label: '佛山' },
  东莞: { latitude: 23.0207, longitude: 113.7518, label: '东莞' },
  香港: { latitude: 22.3193, longitude: 114.1694, label: '香港' },
  澳门: { latitude: 22.1987, longitude: 113.5439, label: '澳门' },
  台北: { latitude: 25.033, longitude: 121.5654, label: '台北' },
};

/**
 * 去掉"市/省/自治区"这类后缀再查，提高命中率。
 * @param {string} city
 * @returns {{ latitude: number, longitude: number, label: string } | null}
 */
export function lookupCity(city) {
  const raw = String(city).trim();
  if (raw === '') return null;

  const stripped = raw.replace(/(特别行政区|自治区|自治州|地区|城市|省|市)$/u, '');
  return CITY_FALLBACK[raw] ?? CITY_FALLBACK[stripped] ?? null;
}
