package main

import (
	"math"
	"strings"
)

const geohashBase32 = "0123456789bcdefghjkmnpqrstuvwxyz"

var geohashDecodeMap = func() map[rune]int {
	m := make(map[rune]int, len(geohashBase32))
	for i, r := range geohashBase32 {
		m[r] = i
	}
	return m
}()

func geohashEncode(lat, lng float64, precision int) string {
	latRange := [2]float64{-90, 90}
	lngRange := [2]float64{-180, 180}
	even := true
	bit := 0
	ch := 0
	var b strings.Builder

	for b.Len() < precision {
		if even {
			mid := (lngRange[0] + lngRange[1]) / 2
			if lng >= mid {
				ch |= 1 << (4 - bit)
				lngRange[0] = mid
			} else {
				lngRange[1] = mid
			}
		} else {
			mid := (latRange[0] + latRange[1]) / 2
			if lat >= mid {
				ch |= 1 << (4 - bit)
				latRange[0] = mid
			} else {
				latRange[1] = mid
			}
		}
		even = !even
		if bit < 4 {
			bit++
		} else {
			b.WriteByte(geohashBase32[ch])
			bit = 0
			ch = 0
		}
	}

	return b.String()
}

func geohashCenter(hash string) (float64, float64) {
	latRange, lngRange := geohashBounds(hash)
	return (latRange[0] + latRange[1]) / 2, (lngRange[0] + lngRange[1]) / 2
}

func geohashBounds(hash string) ([2]float64, [2]float64) {
	latRange := [2]float64{-90, 90}
	lngRange := [2]float64{-180, 180}
	even := true

	for _, r := range hash {
		value, ok := geohashDecodeMap[r]
		if !ok {
			continue
		}
		for mask := 16; mask != 0; mask >>= 1 {
			if even {
				refineRange(&lngRange, value&mask != 0)
			} else {
				refineRange(&latRange, value&mask != 0)
			}
			even = !even
		}
	}

	return latRange, lngRange
}

func refineRange(r *[2]float64, upper bool) {
	mid := (r[0] + r[1]) / 2
	if upper {
		r[0] = mid
	} else {
		r[1] = mid
	}
}

func geohashNeighbors(hash string) []string {
	latRange, lngRange := geohashBounds(hash)
	centerLat := (latRange[0] + latRange[1]) / 2
	centerLng := (lngRange[0] + lngRange[1]) / 2
	latStep := latRange[1] - latRange[0]
	lngStep := lngRange[1] - lngRange[0]

	neighbors := make([]string, 0, 8)
	seen := map[string]bool{}
	for dLat := -1; dLat <= 1; dLat++ {
		for dLng := -1; dLng <= 1; dLng++ {
			if dLat == 0 && dLng == 0 {
				continue
			}
			lat := clamp(centerLat+float64(dLat)*latStep, -90, 90)
			lng := wrapLng(centerLng + float64(dLng)*lngStep)
			n := geohashEncode(lat, lng, len(hash))
			if !seen[n] {
				neighbors = append(neighbors, n)
				seen[n] = true
			}
		}
	}
	return neighbors
}

func clamp(v, lo, hi float64) float64 {
	return math.Max(lo, math.Min(hi, v))
}

func wrapLng(lng float64) float64 {
	for lng < -180 {
		lng += 360
	}
	for lng > 180 {
		lng -= 360
	}
	return lng
}
