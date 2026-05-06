package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	rateLimitSecs    = int64(600)
	ttlSecs          = int64(86400)
	defaultMinCount  = 2
	maxDeltaDeg      = 3.0
	maxCells         = 500
	maxRadiusM       = 20000
	defaultRadiusM   = 3000
	maxLimit         = 200
	defaultLimit     = 50
	defaultWindowSec = int64(3 * 3600)
	p6MaxRadiusM     = 1500
	sampleSize       = 200
	minCityCount     = 3
)

var chinaBounds = struct {
	minLat float64
	maxLat float64
	minLng float64
	maxLng float64
}{18.0, 53.6, 73.5, 135.1}

type Store struct {
	mu          sync.Mutex
	path        string
	Submissions []MoodSubmission     `json:"submissions"`
	Cells       map[string]GeoCell   `json:"cells"`
	RateLimits  map[string]RateLimit `json:"rate_limits"`
}

type MoodSubmission struct {
	ID       string  `json:"id"`
	OpenID   string  `json:"openid"`
	GH6      string  `json:"gh6"`
	GH5      string  `json:"gh5"`
	CellLat  float64 `json:"cell_lat"`
	CellLng  float64 `json:"cell_lng"`
	Mood     int     `json:"mood"`
	City     string  `json:"city"`
	TS       int64   `json:"ts"`
	ExpireAt int64   `json:"expire_at"`
}

type GeoCell struct {
	ID        string  `json:"id"`
	Lat       float64 `json:"lat"`
	Lng       float64 `json:"lng"`
	SumMood   int     `json:"sum_mood"`
	Count     int     `json:"count"`
	MoodDist  []int   `json:"mood_dist"`
	UpdatedAt int64   `json:"updated_at"`
}

type RateLimit struct {
	LastSubmit int64 `json:"last_submit"`
	ExpireAt   int64 `json:"expire_at"`
}

type Server struct {
	store *Store
}

func main() {
	addr := flag.String("addr", ":8080", "HTTP listen address")
	dataPath := flag.String("data", "data/moods.json", "JSON data file path")
	flag.Parse()

	store, err := OpenStore(*dataPath)
	if err != nil {
		log.Fatalf("open data store: %v", err)
	}

	srv := &Server{store: store}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", srv.healthz)
	mux.HandleFunc("/api/submitMood", srv.submitMood)
	mux.HandleFunc("/api/getHeatmap", srv.getHeatmap)
	mux.HandleFunc("/api/getNearbyMoods", srv.getNearbyMoods)
	mux.HandleFunc("/api/getStats", srv.getStats)

	handler := cors(mux)
	log.Printf("Mood Map local server listening on http://127.0.0.1%s", *addr)
	log.Printf("Data file: %s", store.path)
	if err := http.ListenAndServe(*addr, handler); err != nil {
		log.Fatal(err)
	}
}

func OpenStore(path string) (*Store, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}

	store := &Store{
		path:       abs,
		Cells:      map[string]GeoCell{},
		RateLimits: map[string]RateLimit{},
	}

	data, err := os.ReadFile(abs)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return nil, err
		}
		if err := store.saveLocked(); err != nil {
			return nil, err
		}
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return store, nil
	}
	if err := json.Unmarshal(data, store); err != nil {
		return nil, err
	}
	store.path = abs
	if store.Cells == nil {
		store.Cells = map[string]GeoCell{}
	}
	if store.RateLimits == nil {
		store.RateLimits = map[string]RateLimit{}
	}
	store.purgeExpiredLocked(unixNow())
	return store, nil
}

func (s *Store) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *Store) purgeExpiredLocked(now int64) {
	if len(s.Submissions) > 0 {
		next := s.Submissions[:0]
		for _, sub := range s.Submissions {
			if sub.ExpireAt > now {
				next = append(next, sub)
			}
		}
		s.Submissions = next
	}
	for openID, rl := range s.RateLimits {
		if rl.ExpireAt <= now {
			delete(s.RateLimits, openID)
		}
	}
	s.rebuildCellsLocked()
}

func (s *Store) rebuildCellsLocked() {
	cells := map[string]GeoCell{}
	for _, sub := range s.Submissions {
		cell := cells[sub.GH5]
		if cell.ID == "" {
			cell = GeoCell{
				ID:       sub.GH5,
				Lat:      sub.CellLat,
				Lng:      sub.CellLng,
				MoodDist: make([]int, 10),
			}
		}
		cell.SumMood += sub.Mood
		cell.Count++
		if sub.Mood >= 1 && sub.Mood <= 10 {
			cell.MoodDist[sub.Mood-1]++
		}
		if sub.TS > cell.UpdatedAt {
			cell.UpdatedAt = sub.TS
		}
		cells[sub.GH5] = cell
	}
	s.Cells = cells
}

func (srv *Server) healthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (srv *Server) submitMood(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "use POST")
		return
	}

	var req struct {
		Lat  any `json:"lat"`
		Lng  any `json:"lng"`
		Mood any `json:"mood"`
	}
	if err := readJSON(r, &req); err != nil {
		writeWrapped(w, errResult("INVALID_JSON", err.Error()))
		return
	}

	mood, ok := strictInt(req.Mood)
	if !ok || mood < 1 || mood > 10 {
		writeWrapped(w, errResult("INVALID_MOOD", "mood must be an integer 1-10"))
		return
	}

	lat, okLat := numberValue(req.Lat)
	lng, okLng := numberValue(req.Lng)
	if !okLat || !okLng || lat < chinaBounds.minLat || lat > chinaBounds.maxLat || lng < chinaBounds.minLng || lng > chinaBounds.maxLng {
		writeWrapped(w, errResult("INVALID_COORDS", "coordinates out of valid range"))
		return
	}

	openID := clientID(r)
	now := unixNow()
	gh6 := geohashEncode(lat, lng, 6)
	gh5 := geohashEncode(lat, lng, 5)
	cellLat, cellLng := geohashCenter(gh6)
	city := cityFromLatLng(cellLat, cellLng)

	srv.store.mu.Lock()
	defer srv.store.mu.Unlock()
	srv.store.purgeExpiredLocked(now)

	if rl, exists := srv.store.RateLimits[openID]; exists && now-rl.LastSubmit < rateLimitSecs {
		wait := rateLimitSecs - (now - rl.LastSubmit)
		writeWrapped(w, errResult("RATE_LIMITED", fmt.Sprintf("please wait %ds before submitting again", wait)))
		return
	}

	sub := MoodSubmission{
		ID:       fmt.Sprintf("%d-%s", nowNano(), gh6),
		OpenID:   openID,
		GH6:      gh6,
		GH5:      gh5,
		CellLat:  cellLat,
		CellLng:  cellLng,
		Mood:     mood,
		City:     city,
		TS:       now,
		ExpireAt: now + ttlSecs,
	}
	srv.store.Submissions = append(srv.store.Submissions, sub)
	upsertCell(srv.store.Cells, sub)
	srv.store.RateLimits[openID] = RateLimit{LastSubmit: now, ExpireAt: now + rateLimitSecs}

	if err := srv.store.saveLocked(); err != nil {
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}

	writeWrapped(w, map[string]any{
		"ok":         true,
		"cell":       gh6,
		"snapped_to": map[string]float64{"lat": cellLat, "lng": cellLng},
		"city":       city,
	})
}

func (srv *Server) getHeatmap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "use POST")
		return
	}

	var req struct {
		SW       point `json:"sw"`
		NE       point `json:"ne"`
		MinCount any   `json:"min_count"`
	}
	if err := readJSON(r, &req); err != nil {
		writeWrapped(w, errResult("INVALID_JSON", err.Error()))
		return
	}
	if !req.SW.valid() || !req.NE.valid() {
		writeWrapped(w, errResult("INVALID_BBOX", "sw and ne must be {lat, lng} objects"))
		return
	}
	latDelta := req.NE.Lat - req.SW.Lat
	lngDelta := req.NE.Lng - req.SW.Lng
	if latDelta <= 0 || lngDelta <= 0 {
		writeWrapped(w, errResult("INVALID_BBOX", "ne must be strictly north-east of sw"))
		return
	}
	if latDelta > maxDeltaDeg || lngDelta > maxDeltaDeg {
		writeWrapped(w, errResult("BBOX_TOO_LARGE", fmt.Sprintf("viewport must be <= %.1f degrees per side", maxDeltaDeg)))
		return
	}
	minCount := defaultMinCount
	if parsed, ok := looseInt(req.MinCount); ok && parsed > 0 {
		minCount = parsed
	}

	now := unixNow()
	srv.store.mu.Lock()
	srv.store.purgeExpiredLocked(now)
	cells := make([]map[string]any, 0, len(srv.store.Cells))
	for _, cell := range srv.store.Cells {
		if cell.Count < minCount {
			continue
		}
		if cell.Lat < req.SW.Lat || cell.Lat > req.NE.Lat || cell.Lng < req.SW.Lng || cell.Lng > req.NE.Lng {
			continue
		}
		cells = append(cells, map[string]any{
			"gh5":        cell.ID,
			"lat":        cell.Lat,
			"lng":        cell.Lng,
			"avg_mood":   round1(float64(cell.SumMood) / float64(cell.Count)),
			"count":      cell.Count,
			"mood_dist":  cell.MoodDist,
			"updated_at": cell.UpdatedAt,
		})
	}
	sort.Slice(cells, func(i, j int) bool {
		return cells[i]["count"].(int) > cells[j]["count"].(int)
	})
	if len(cells) > maxCells {
		cells = cells[:maxCells]
	}
	if err := srv.store.saveLocked(); err != nil {
		srv.store.mu.Unlock()
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}
	srv.store.mu.Unlock()

	writeWrapped(w, map[string]any{
		"ok":           true,
		"cells":        cells,
		"count":        len(cells),
		"generated_at": now,
	})
}

func (srv *Server) getNearbyMoods(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "use POST")
		return
	}

	var req struct {
		Lat    any `json:"lat"`
		Lng    any `json:"lng"`
		Radius any `json:"radius"`
		Limit  any `json:"limit"`
		Since  any `json:"since"`
	}
	if err := readJSON(r, &req); err != nil {
		writeWrapped(w, errResult("INVALID_JSON", err.Error()))
		return
	}
	lat, okLat := numberValue(req.Lat)
	lng, okLng := numberValue(req.Lng)
	if !okLat || !okLng {
		writeWrapped(w, errResult("INVALID_COORDS", "lat and lng must be valid numbers"))
		return
	}

	radius := defaultRadiusM
	if parsed, ok := looseInt(req.Radius); ok && parsed > 0 {
		radius = min(parsed, maxRadiusM)
	}
	limit := defaultLimit
	if parsed, ok := looseInt(req.Limit); ok && parsed > 0 {
		limit = min(parsed, maxLimit)
	}
	since := unixNow() - defaultWindowSec
	if parsed, ok := looseInt64(req.Since); ok && parsed > 0 {
		since = parsed
	}

	precision := 5
	fieldGH6 := false
	if radius <= p6MaxRadiusM {
		precision = 6
		fieldGH6 = true
	}
	center := geohashEncode(lat, lng, precision)
	window := map[string]bool{center: true}
	for _, n := range geohashNeighbors(center) {
		window[n] = true
	}

	now := unixNow()
	srv.store.mu.Lock()
	srv.store.purgeExpiredLocked(now)
	entries := make([]nearbyEntry, 0, len(srv.store.Submissions))
	for _, sub := range srv.store.Submissions {
		if sub.TS < since {
			continue
		}
		key := sub.GH5
		if fieldGH6 {
			key = sub.GH6
		}
		if !window[key] {
			continue
		}
		dist := haversine(lat, lng, sub.CellLat, sub.CellLng)
		if dist > float64(radius) {
			continue
		}
		entries = append(entries, nearbyEntry{
			GH6:     sub.GH6,
			Mood:    sub.Mood,
			TS:      sub.TS,
			CellLat: sub.CellLat,
			CellLng: sub.CellLng,
			DistM:   int(math.Round(dist)),
			City:    sub.City,
		})
	}
	if err := srv.store.saveLocked(); err != nil {
		srv.store.mu.Unlock()
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}
	srv.store.mu.Unlock()

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].DistM == entries[j].DistM {
			return entries[i].TS > entries[j].TS
		}
		return entries[i].DistM < entries[j].DistM
	})
	if len(entries) > limit {
		entries = entries[:limit]
	}

	writeWrapped(w, map[string]any{
		"ok":      true,
		"center":  map[string]float64{"lat": lat, "lng": lng},
		"radius":  radius,
		"count":   len(entries),
		"entries": entries,
	})
}

func (srv *Server) getStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "use GET or POST")
		return
	}

	now := unixNow()
	srv.store.mu.Lock()
	srv.store.purgeExpiredLocked(now)
	docs := append([]MoodSubmission(nil), srv.store.Submissions...)
	if err := srv.store.saveLocked(); err != nil {
		srv.store.mu.Unlock()
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}
	srv.store.mu.Unlock()

	sort.Slice(docs, func(i, j int) bool { return docs[i].TS > docs[j].TS })
	if len(docs) > sampleSize {
		docs = docs[:sampleSize]
	}
	if len(docs) == 0 {
		writeWrapped(w, map[string]any{"ok": true, "empty": true, "totalCount": 0})
		return
	}

	totalMood := 0
	count24h := 0
	now24hAgo := now - ttlSecs
	cities := map[string]cityAgg{}
	for _, doc := range docs {
		totalMood += doc.Mood
		if doc.TS >= now24hAgo {
			count24h++
		}
		city := doc.City
		if city == "" {
			city = "其他"
		}
		agg := cities[city]
		agg.Count++
		agg.Sum += doc.Mood
		cities[city] = agg
	}

	cityEntries := make([]cityRank, 0, len(cities))
	for name, agg := range cities {
		cityEntries = append(cityEntries, cityRank{
			City:  name,
			Avg:   round1(float64(agg.Sum) / float64(agg.Count)),
			Count: agg.Count,
		})
	}

	var happiest *cityRank
	for _, item := range cityEntries {
		if item.Count < minCityCount {
			continue
		}
		candidate := item
		if happiest == nil || candidate.Avg > happiest.Avg {
			happiest = &candidate
		}
	}

	mostActive := cityEntries[0]
	for _, item := range cityEntries[1:] {
		if item.Count > mostActive.Count {
			mostActive = item
		}
	}

	rankings := make([]cityRank, 0, len(cityEntries))
	for _, item := range cityEntries {
		if item.Count >= minCityCount {
			rankings = append(rankings, item)
		}
	}
	sort.Slice(rankings, func(i, j int) bool {
		if rankings[i].Avg == rankings[j].Avg {
			return rankings[i].Count > rankings[j].Count
		}
		return rankings[i].Avg > rankings[j].Avg
	})
	if len(rankings) > 20 {
		rankings = rankings[:20]
	}

	happiestName := any(nil)
	if happiest != nil {
		happiestName = happiest.City
	}

	writeWrapped(w, map[string]any{
		"ok":           true,
		"empty":        false,
		"totalCount":   len(docs),
		"avgMood":      round1(float64(totalMood) / float64(len(docs))),
		"cityCount":    len(cities),
		"happiest":     happiestName,
		"mostActive":   mostActive.City,
		"speed":        round1(float64(count24h) / 24.0),
		"cityRankings": rankings,
		"generatedAt":  now,
	})
}

type point struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

func (p point) valid() bool {
	return !math.IsNaN(p.Lat) && !math.IsNaN(p.Lng)
}

type nearbyEntry struct {
	GH6     string  `json:"gh6"`
	Mood    int     `json:"mood"`
	TS      int64   `json:"ts"`
	CellLat float64 `json:"cell_lat"`
	CellLng float64 `json:"cell_lng"`
	DistM   int     `json:"dist_m"`
	City    string  `json:"city"`
}

type cityAgg struct {
	Count int
	Sum   int
}

type cityRank struct {
	City  string  `json:"city"`
	Avg   float64 `json:"avg"`
	Count int     `json:"count"`
}

func upsertCell(cells map[string]GeoCell, sub MoodSubmission) {
	cell := cells[sub.GH5]
	if cell.ID == "" {
		cell = GeoCell{
			ID:       sub.GH5,
			Lat:      sub.CellLat,
			Lng:      sub.CellLng,
			MoodDist: make([]int, 10),
		}
	}
	cell.SumMood += sub.Mood
	cell.Count++
	if sub.Mood >= 1 && sub.Mood <= 10 {
		cell.MoodDist[sub.Mood-1]++
	}
	cell.UpdatedAt = sub.TS
	cells[sub.GH5] = cell
}

func readJSON(r *http.Request, dst any) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.UseNumber()
	return decoder.Decode(dst)
}

func writeWrapped(w http.ResponseWriter, result map[string]any) {
	writeJSON(w, http.StatusOK, map[string]any{"result": result})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("write response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, code string, msg string) {
	writeJSON(w, status, map[string]any{"result": errResult(code, msg)})
}

func errResult(code string, msg string) map[string]any {
	return map[string]any{"ok": false, "code": code, "msg": msg}
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Mood-Client")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func clientID(r *http.Request) string {
	if id := strings.TrimSpace(r.Header.Get("X-Mood-Client")); id != "" {
		return id
	}
	host := strings.TrimSpace(r.RemoteAddr)
	if host == "" {
		return "local-dev"
	}
	return host
}

func strictInt(v any) (int, bool) {
	switch n := v.(type) {
	case json.Number:
		i, err := strconv.Atoi(n.String())
		return i, err == nil
	case float64:
		if math.Trunc(n) != n {
			return 0, false
		}
		return int(n), true
	case int:
		return n, true
	case string:
		i, err := strconv.Atoi(n)
		return i, err == nil
	default:
		return 0, false
	}
}

func looseInt(v any) (int, bool) {
	switch n := v.(type) {
	case nil:
		return 0, false
	case json.Number:
		i, err := strconv.Atoi(n.String())
		if err == nil {
			return i, true
		}
		f, err := strconv.ParseFloat(n.String(), 64)
		return int(f), err == nil
	case float64:
		return int(n), true
	case string:
		i, err := strconv.Atoi(n)
		return i, err == nil
	default:
		return 0, false
	}
}

func looseInt64(v any) (int64, bool) {
	i, ok := looseInt(v)
	return int64(i), ok
}

func numberValue(v any) (float64, bool) {
	switch n := v.(type) {
	case json.Number:
		f, err := strconv.ParseFloat(n.String(), 64)
		return f, err == nil
	case float64:
		return n, true
	case string:
		f, err := strconv.ParseFloat(n, 64)
		return f, err == nil
	default:
		return 0, false
	}
}

func unixNow() int64 {
	return time.Now().Unix()
}

func nowNano() int64 {
	return time.Now().UnixNano()
}

func round1(n float64) float64 {
	return math.Round(n*10) / 10
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func haversine(lat1, lng1, lat2, lng2 float64) float64 {
	const earthRadiusM = 6371000.0
	phi1 := toRad(lat1)
	phi2 := toRad(lat2)
	dPhi := toRad(lat2 - lat1)
	dLambda := toRad(lng2 - lng1)
	a := math.Sin(dPhi/2)*math.Sin(dPhi/2) + math.Cos(phi1)*math.Cos(phi2)*math.Sin(dLambda/2)*math.Sin(dLambda/2)
	return earthRadiusM * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

func toRad(deg float64) float64 {
	return deg * math.Pi / 180
}

type cityBox struct {
	name   string
	latMin float64
	latMax float64
	lngMin float64
	lngMax float64
}

var cityBoxes = []cityBox{
	{"北京", 39.44, 41.05, 115.42, 117.51},
	{"上海", 30.67, 31.87, 120.85, 122.03},
	{"天津", 38.55, 40.25, 116.70, 118.05},
	{"重庆", 28.10, 32.20, 105.25, 110.20},
	{"石家庄", 37.50, 38.80, 113.85, 115.25},
	{"太原", 37.25, 38.20, 111.80, 113.10},
	{"呼和浩特", 40.40, 41.20, 111.10, 112.40},
	{"沈阳", 41.10, 42.40, 122.60, 123.85},
	{"大连", 38.75, 40.00, 120.55, 122.75},
	{"长春", 43.20, 44.80, 124.90, 126.45},
	{"哈尔滨", 44.75, 46.40, 126.10, 128.00},
	{"南京", 31.20, 32.60, 118.20, 119.35},
	{"苏州", 30.65, 32.10, 119.90, 121.25},
	{"无锡", 31.20, 31.90, 119.85, 120.75},
	{"杭州", 29.20, 30.60, 119.00, 120.85},
	{"宁波", 28.95, 30.10, 120.95, 122.30},
	{"合肥", 31.20, 32.40, 116.55, 117.85},
	{"南昌", 28.20, 29.25, 115.55, 116.55},
	{"福州", 25.50, 26.70, 118.55, 120.30},
	{"厦门", 24.40, 24.90, 117.80, 118.45},
	{"济南", 35.95, 37.50, 116.05, 117.85},
	{"青岛", 35.55, 37.20, 119.45, 121.05},
	{"武汉", 29.85, 31.40, 113.65, 115.10},
	{"郑州", 34.10, 35.50, 112.65, 114.35},
	{"长沙", 27.55, 28.90, 111.95, 114.05},
	{"广州", 22.50, 23.95, 112.85, 114.10},
	{"深圳", 22.40, 22.90, 113.70, 114.65},
	{"东莞", 22.60, 23.20, 113.55, 114.30},
	{"佛山", 22.70, 23.50, 112.70, 113.45},
	{"南宁", 22.15, 23.55, 107.45, 108.90},
	{"海口", 19.70, 20.25, 110.00, 110.70},
	{"成都", 29.95, 31.45, 103.15, 104.95},
	{"贵阳", 25.95, 27.00, 106.15, 107.45},
	{"昆明", 24.00, 25.60, 102.10, 103.80},
	{"拉萨", 29.40, 30.20, 90.80, 91.80},
	{"西安", 33.50, 34.80, 107.55, 109.25},
	{"兰州", 35.50, 36.70, 103.25, 104.35},
	{"西宁", 36.45, 37.25, 101.55, 102.05},
	{"银川", 37.75, 38.85, 105.75, 106.95},
	{"乌鲁木齐", 43.20, 44.30, 87.10, 88.65},
}

func cityFromLatLng(lat, lng float64) string {
	for _, box := range cityBoxes {
		if lat >= box.latMin && lat <= box.latMax && lng >= box.lngMin && lng <= box.lngMax {
			return box.name
		}
	}
	return "其他"
}
