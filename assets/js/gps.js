function toRad(x){ return x * Math.PI / 180; }
function haversineMeters(lat1, lon1, lat2, lon2){
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}
function fmtMeters(m){
  if (!isFinite(m)) return "";
  if (m < 1000) return Math.round(m) + " m";
  const km = m / 1000;
  return km.toFixed(km < 10 ? 2 : 1).replace(".", ",") + " km";
}
function getPos(){
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation){
      reject(new Error("A böngésző nem támogatja a helymeghatározást."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      (err) => reject(err),
      { enableHighAccuracy:true, timeout:12000, maximumAge:0 }
    );
  });
}
function storageKey(dayId, poiId){
  return "kekduna:" + dayId + ":poi:" + poiId + ":lastDist";
}
function indicatorFromDelta(delta){
  if (!isFinite(delta)) return { cls:"warn", text:"nincs előzmény" };
  if (Math.abs(delta) < 15) return { cls:"warn", text:"kb ugyanott" };
  if (delta < 0) return { cls:"ok", text:"közeledsz" };
  return { cls:"bad", text:"távolodsz, elhagytad" };
}
async function measureToPoi(dayId, poi){
  const pos = await getPos();
  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  const dist = haversineMeters(lat, lon, poi.lat, poi.lon);
  const key = storageKey(dayId, poi.id);
  const prev = parseFloat(localStorage.getItem(key));
  localStorage.setItem(key, String(dist));
  const delta = dist - prev;
  const ind = indicatorFromDelta(delta);
  return { dist, prev, delta, ind, lat, lon };
}
async function measureNearest(dayId, pois){
  const pos = await getPos();
  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  let best = null;
  for (const p of pois){
    const d = haversineMeters(lat, lon, p.lat, p.lon);
    if (!best || d < best.dist){
      best = { poi:p, dist:d };
    }
  }
  return { ...best, lat, lon };
}