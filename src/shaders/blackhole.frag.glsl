#version 300 es
// vivar: per-pixel null-geodesic tracer for a Schwarzschild or Kerr black hole.
//
// Units: r_s = 1 (G = c = 1, M = 1/2). Each pixel's ray is traced backwards
// from a static camera.
//
// KERR 0 (spin a = 0): the ray's orbit lies in the plane spanned by the camera
// position and the ray direction; in that plane we integrate the Binet form
//     u'' = -u + 1.5 r_s u^2,   u = 1/r,  ' = d/dphi
// with RK4 and an adaptive step. Mirrored by src/physics/geodesic.ts.
//
// KERR 1 (a > 0): no planar reduction exists. We integrate Hamilton's
// equations for the time-reversed ray in Kerr-Schild Cartesian coordinates
// (no pole singularity, regular horizon), with RK4 in the affine parameter.
// Mirrored by src/physics/kerr.ts, which documents the equations.
// With lensing off, both variants trace straight lines with the Binet code.
precision highp float;
precision highp int;

//#include constants

in vec2 v_uv;
out vec4 outColor;

uniform vec3 u_camPos;
uniform vec3 u_camRight;
uniform vec3 u_camUp;
uniform vec3 u_camForward;
uniform vec2 u_tan;          // tan(half FOV) along x and y
uniform float u_time;        // disk animation time, r_s / c
uniform int u_maxSteps;
uniform float u_hBase;       // cap on dphi per step
uniform float u_eps;         // target |d ln u| per step
uniform int u_octaves;
uniform bool u_doppler;
uniform bool u_grav;
uniform bool u_lensing;
uniform bool u_disk;
uniform bool u_guides;
uniform bool u_debug;
uniform float u_split;       // NDC x beyond which rays are straight (> 1 disables)
uniform float u_tPeak;       // peak disk temperature, K
uniform sampler2D u_bbLut;   // blackbody colour, log-T axis, unit luminance
uniform float u_outScale;    // 1 for float targets; < 1 to fit HDR into an RGBA8 fallback
uniform float u_rIn;         // disk inner edge (the prograde ISCO)
uniform float u_rCapture;    // straight rays are absorbed inside this radius (the horizon)
uniform float u_fluxNorm;    // 1 / peak of fluxShape for a non-spinning disk
uniform vec4 u_guideR;       // guide circles: horizon, prograde and retrograde photon orbits, ISCO
#if KERR
uniform float u_spin;        // a = chi * M, a length in r_s
uniform float u_rH;          // outer horizon r+
uniform vec3 u_kPos;         // camera position in Kerr-Schild coordinates (app axes)
uniform vec4 u_kU;           // lowered static-observer tetrad (t, x, y, z):
uniform vec4 u_kR;           //   time, right = e_phi, up = -e_theta, forward = -e_r
uniform vec4 u_kUp;
uniform vec4 u_kF;
uniform float u_obsLapse2;   // -g_tt at the camera
uniform float u_hK;          // affine step as a fraction of (r - K_HORIZON r+)
#endif

// ---------------------------------------------------------------- geodesic

float binetAccel(float u, bool gr) {
  return gr ? -u + 1.5 * R_S * u * u : -u;
}

void rk4(inout float u, inout float w, float h, bool gr) {
  float k1u = w;
  float k1w = binetAccel(u, gr);
  float k2u = w + 0.5 * h * k1w;
  float k2w = binetAccel(u + 0.5 * h * k1u, gr);
  float k3u = w + 0.5 * h * k2w;
  float k3w = binetAccel(u + 0.5 * h * k2u, gr);
  float k4u = w + h * k3w;
  float k4w = binetAccel(u + h * k3u, gr);
  u += (h / 6.0) * (k1u + 2.0 * k2u + 2.0 * k3u + k4u);
  w += (h / 6.0) * (k1w + 2.0 * k2w + 2.0 * k3w + k4w);
}

float stepSize(float u, float w) {
  float h = u_eps * u / max(abs(w), 1e-12);
  return min(u_hBase, max(h, H_MIN));
}

#if KERR
// ---------------------------------------------------------------- Kerr geodesic
// App axes: spin axis +y. Kerr-Schild (X, Y, Z) = (z, x, y). Traced spacetime
// has spin s = -a (time reversal); its metric is eta + f k k, k = (1, l).

// Boyer-Lindquist r of a Kerr-Schild point.
float ksRadius(vec3 q, float a) {
  float a2 = a * a;
  float w = dot(q, q) - a2;
  float r2 = 0.5 * (w + sqrt(w * w + 4.0 * a2 * q.y * q.y));
  return sqrt(r2);
}

// Hamilton's equations: dq/dl = p - f L l, dp/dl = L^2 grad(f)/2 + f L grad(l.p),
// L = 1 + l.p (p_t = -1). Returns r.
float kerrRhs(vec3 q, vec3 p, float a, out vec3 dq, out vec3 dp) {
  float r = ksRadius(q, a);
  float r2 = r * r;
  float a2 = a * a;
  float y = q.y;
  float sig = r2 * r2 + a2 * y * y;
  float A = 1.0 / (r2 + a2);
  vec3 l = vec3((r * q.x + a * q.z) * A, y / r, (r * q.z - a * q.x) * A);
  float L = 1.0 + dot(l, p);
  float f = 2.0 * MASS * r2 * r / sig;
  vec3 gr = vec3(q.x * r2 * r, y * r * (r2 + a2), q.z * r2 * r) / sig;
  float kf = 2.0 * MASS * r2 / (sig * sig);
  float cf = 3.0 * a2 * y * y - r2 * r2;
  vec3 gf = kf * (cf * gr - vec3(0.0, 2.0 * a2 * r * y, 0.0));
  float S = A * (q.x * p.x + q.z * p.z - 2.0 * r * (l.x * p.x + l.z * p.z)) - p.y * y / r2;
  vec3 gl = S * gr + vec3(A * (r * p.x - a * p.z), p.y / r, A * (r * p.z + a * p.x));
  float fL = f * L;
  dq = p - fL * l;
  dp = 0.5 * L * L * gf + fL * gl;
  return r;
}

// One RK4 step of size h; (k1q, k1p) is the derivative already known at (q, p).
void kerrRk4(inout vec3 q, inout vec3 p, vec3 k1q, vec3 k1p, float h, float a) {
  vec3 k2q; vec3 k2p; vec3 k3q; vec3 k3p; vec3 k4q; vec3 k4p;
  float r2 = kerrRhs(q + 0.5 * h * k1q, p + 0.5 * h * k1p, a, k2q, k2p);
  float r3 = kerrRhs(q + 0.5 * h * k2q, p + 0.5 * h * k2p, a, k3q, k3p);
  float r4 = kerrRhs(q + h * k3q, p + h * k3p, a, k4q, k4p);
  q += (h / 6.0) * (k1q + 2.0 * k2q + 2.0 * k3q + k4q);
  p += (h / 6.0) * (k1p + 2.0 * k2p + 2.0 * k3p + k4p);
}

float kerrStepSize(float r, float speed, float rH, float h) {
  return h * (r - K_HORIZON * rH) / max(speed, 1e-6);
}

// Root in [0, 1] of the cubic Hermite interpolant through (y0, m0), (y1, m1).
float hermiteRoot(float y0, float y1, float m0, float m1) {
  float t = y0 / (y0 - y1);
  for (int i = 0; i < 3; i++) {
    float t2 = t * t;
    float t3 = t2 * t;
    float v = (2.0 * t3 - 3.0 * t2 + 1.0) * y0 + (t3 - 2.0 * t2 + t) * m0 + (-2.0 * t3 + 3.0 * t2) * y1 + (t3 - t2) * m1;
    float d = (6.0 * t2 - 6.0 * t) * y0 + (3.0 * t2 - 4.0 * t + 1.0) * m0 + (-6.0 * t2 + 6.0 * t) * y1 + (3.0 * t2 - 2.0 * t) * m1;
    t = clamp(t - v / (abs(d) > 1e-12 ? d : 1e-12), 0.0, 1.0);
  }
  return t;
}

vec3 hermite3(vec3 y0, vec3 y1, vec3 m0, vec3 m1, float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return (2.0 * t3 - 3.0 * t2 + 1.0) * y0 + (t3 - 2.0 * t2 + t) * m0 + (-2.0 * t3 + 3.0 * t2) * y1 + (t3 - t2) * m1;
}

// Prograde circular orbit (Bardeen, Press & Teukolsky 1972): Omega, and the
// redshift g of light with l = L/E reaching a static observer with -g_tt = obsLapse2.
// `grav` receives the ZAMO-referenced gravitational part (see kerr.ts).
float kerrOmega(float r, float a) {
  float sm = sqrt(MASS);
  return sm / (r * sqrt(r) + a * sm);
}

// Offset from the traced ray's Kerr-Schild azimuth to Boyer-Lindquist azimuth
// at equatorial radius r (app convention atan(z, x)); s = -a, r- = 2M - r+.
float blAzimuthOffset(float r, float a, float rH) {
  float s = -a;
  float rM = 2.0 * MASS - rH;
  return atan(s / r) + s / (rH - rM) * log((r - rH) / (r - rM));
}

float kerrRedshift(float r, float a, float ell, float obsLapse2, out float grav) {
  float sm = sqrt(MASS);
  float r32 = r * sqrt(r);
  float omega = sm / (r32 + a * sm);
  float ut = (r32 + a * sm) / (pow(r, 0.75) * sqrt(r32 - 3.0 * MASS * sqrt(r) + 2.0 * a * sm));
  float obs = sqrt(obsLapse2);
  float delta = r * r - 2.0 * MASS * r + a * a;
  float bigA = (r * r + a * a) * (r * r + a * a) - a * a * delta;
  float alpha = r * sqrt(delta / bigA);
  float w = 2.0 * MASS * a * r / bigA;
  grav = alpha / ((1.0 - w * ell) * obs);
  return 1.0 / (ut * (1.0 - omega * ell) * obs);
}
#endif

// ---------------------------------------------------------------- noise

uvec3 pcg3d(uvec3 v) {
  // Jarzynski & Olano, "Hash Functions for GPU Rendering", JCGT 2020.
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

vec3 hash33(ivec3 c) {
  return vec3(pcg3d(uvec3(c + 65536))) * (1.0 / 4294967295.0);
}

vec3 gradAt(ivec3 c) {
  return normalize(hash33(c) * 2.0 - 1.0 + 1e-4);
}

// Gradient noise in [-1, 1] (roughly), quintic fade.
float gnoise(vec3 p) {
  ivec3 i = ivec3(floor(p));
  vec3 f = fract(p);
  vec3 s = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(gradAt(i), f);
  float n100 = dot(gradAt(i + ivec3(1, 0, 0)), f - vec3(1, 0, 0));
  float n010 = dot(gradAt(i + ivec3(0, 1, 0)), f - vec3(0, 1, 0));
  float n110 = dot(gradAt(i + ivec3(1, 1, 0)), f - vec3(1, 1, 0));
  float n001 = dot(gradAt(i + ivec3(0, 0, 1)), f - vec3(0, 0, 1));
  float n101 = dot(gradAt(i + ivec3(1, 0, 1)), f - vec3(1, 0, 1));
  float n011 = dot(gradAt(i + ivec3(0, 1, 1)), f - vec3(0, 1, 1));
  float n111 = dot(gradAt(i + ivec3(1, 1, 1)), f - vec3(1, 1, 1));
  float x00 = mix(n000, n100, s.x);
  float x10 = mix(n010, n110, s.x);
  float x01 = mix(n001, n101, s.x);
  float x11 = mix(n011, n111, s.x);
  return 1.6 * mix(mix(x00, x10, s.y), mix(x01, x11, s.y), s.z);
}

float fbm(vec3 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * gnoise(p);
    p = p * 2.07 + vec3(3.1, 7.7, 1.3);
    amp *= 0.5;
  }
  return sum;
}

// ---------------------------------------------------------------- colour

vec3 blackbody(float t) {
  float s = log(clamp(t, LUT_T_MIN, LUT_T_MAX) / LUT_T_MIN) / log(LUT_T_MAX / LUT_T_MIN);
  return texture(u_bbLut, vec2(s, 0.5)).rgb;
}

// ---------------------------------------------------------------- disk

float fluxShape(float r) {
  return max(0.0, 1.0 - sqrt(u_rIn / r)) / (r * r * r);
}

// One layer of the animated disk texture. `age` is time since this layer was
// last reset; gas at radius r has rotated by Omega(r) * age since then.
float diskLayer(float r, float azimuth, float omega, float age, float seed) {
  // Material now at `azimuth` was at azimuth + Omega*age when the layer reset
  // (the disk rotates in the +y sense, which decreases atan(z, x)).
  float a = azimuth + omega * age + seed * 17.0;
  float lr = log(r);
  vec3 p = vec3(cos(a) * 1.8, sin(a) * 1.8, lr * 6.0 + seed * 31.0);
  float n = fbm(p, u_octaves);
  // Sharpen into filaments, plus some thin rings for texture.
  float bands = 0.5 + 0.5 * sin(lr * 38.0 + n * 5.0);
  return n + 0.15 * (bands - 0.5);
}

// Returns premultiplied emission (rgb) and opacity (a) of the disk at P.
vec4 shadeDisk(vec3 P, float r, float ell, float rCam) {
#if KERR
  float omega = kerrOmega(r, u_spin);
  // Lay the texture out in Boyer-Lindquist azimuth, where orbits are circles.
  float azimuth = atan(P.z, P.x) + blAzimuthOffset(r, u_spin, u_rH);
#else
  float omega = sqrt(R_S / (2.0 * r * r * r));
  float azimuth = atan(P.z, P.x);
#endif

  // Two copies of the texture, each reset every FLOW_PERIOD and cross-faded,
  // so Keplerian shear never winds the pattern into unresolvable spirals.
  float t1 = mod(u_time, FLOW_PERIOD);
  float t2 = mod(u_time + 0.5 * FLOW_PERIOD, FLOW_PERIOD);
  float w1 = 1.0 - abs(2.0 * t1 / FLOW_PERIOD - 1.0);
  float w2 = 1.0 - w1;
  float k1 = floor(u_time / FLOW_PERIOD);
  float k2 = floor((u_time + 0.5 * FLOW_PERIOD) / FLOW_PERIOD);
  float n1 = diskLayer(r, azimuth, omega, t1, fract(k1 * 0.618));
  float n2 = diskLayer(r, azimuth, omega, t2, fract(k2 * 0.618 + 0.31));
  float n = (w1 * n1 + w2 * n2) / sqrt(w1 * w1 + w2 * w2);

  float density = clamp(0.7 + 1.0 * n, 0.0, 1.6);

  // Redshift factor g = nu_obs / nu_emit, split into its two exact factors.
  float g = 1.0;
#if KERR
  float gGrav;
  float gAll = kerrRedshift(r, u_spin, ell, u_obsLapse2, gGrav);
  if (u_doppler) g *= gAll / gGrav;                // emitter vs local ZAMO
  if (u_grav) g *= gGrav;                          // ZAMO vs camera, frame dragging included
#else
  if (u_doppler) {
    float v = sqrt(R_S / (2.0 * (r - R_S)));       // local orbital speed (c/2 at ISCO)
    g *= sqrt(1.0 - v * v) / (1.0 - omega * ell);  // special-relativistic Doppler, v cos(theta) = Omega * l
  }
  if (u_grav) {
    g *= sqrt(1.0 - R_S / r) / sqrt(1.0 - R_S / rCam);
  }
#endif

  // Flux relative to the peak of a non-spinning disk with the same accretion
  // rate: with spin the disk reaches further in and its inner part runs hotter.
  float fRel = fluxShape(r) * u_fluxNorm;
  float tEmit = u_tPeak * pow(fRel, 0.25);
  // Observed spectrum is a blackbody at g*T; bolometric intensity scales as g^4.
  float g2 = g * g;
  float intensity = g2 * g2 * fRel;

  float outer = smoothstep(DISK_OUTER, DISK_OUTER * 0.72, r);
  float inner = smoothstep(u_rIn, u_rIn * 1.06, r);
  // Optically thick inside, thinning and wispy towards the outer edge.
  float opacity = mix(1.0, 0.8, smoothstep(6.0, 13.0, r));
  float alpha = clamp((0.55 + density) * opacity, 0.0, 1.0) * outer * mix(0.7, 1.0, inner);
  vec3 col = blackbody(g * tEmit) * intensity * (0.35 + 0.65 * density) * 1.1;
  return vec4(col * alpha, alpha);
}

// ---------------------------------------------------------------- sky

vec3 faceDir(int face, vec2 uv) {
  if (face == 0) return vec3(1.0, uv.y, uv.x);
  if (face == 1) return vec3(-1.0, uv.y, -uv.x);
  if (face == 2) return vec3(uv.x, 1.0, uv.y);
  if (face == 3) return vec3(uv.x, -1.0, -uv.y);
  if (face == 4) return vec3(-uv.x, uv.y, 1.0);
  return vec3(uv.x, uv.y, -1.0);
}

void dirFace(vec3 d, out int face, out vec2 uv) {
  vec3 a = abs(d);
  if (a.x >= a.y && a.x >= a.z) {
    face = d.x > 0.0 ? 0 : 1;
    uv = d.x > 0.0 ? vec2(d.z, d.y) / a.x : vec2(-d.z, d.y) / a.x;
  } else if (a.y >= a.z) {
    face = d.y > 0.0 ? 2 : 3;
    uv = d.y > 0.0 ? vec2(d.x, d.z) / a.y : vec2(d.x, -d.z) / a.y;
  } else {
    face = d.z > 0.0 ? 4 : 5;
    uv = d.z > 0.0 ? vec2(-d.x, d.y) / a.z : vec2(d.x, d.y) / a.z;
  }
}

// One layer of point stars on a cube-face grid; at most one star per cell.
// `fp` is the angular footprint of this pixel after lensing. Stars are
// widened to at least that size with their energy conserved, and once the
// footprint approaches the cell size they fade into the layer's mean
// radiance, so strongly lensed regions shimmer far less.
const float STAR_SIGMA = 6.0e-4;   // intrinsic angular size of a star, radians
vec3 starLayer(vec3 d, float cells, float density, float gain, float fp, int layer) {
  int face;
  vec2 uv;
  dirFace(d, face, uv);
  vec2 g = (uv * 0.5 + 0.5) * cells;
  ivec2 c = ivec2(floor(g));
  vec3 h = hash33(ivec3(c, face * 7 + layer * 101));
  float cellAngle = 2.0 / cells;
  float sigma = clamp(0.6 * fp, STAR_SIGMA, 0.12 * cellAngle);
  vec3 star = vec3(0.0);
  if (h.z < density) {
    vec3 h2 = hash33(ivec3(c, face * 7 + layer * 101 + 1));
    vec2 sp = (vec2(c) + 0.3 + 0.4 * h2.xy) / cells * 2.0 - 1.0;
    vec3 sd = normalize(faceDir(face, sp));
    vec3 dd = d - sd;
    float ang2 = dot(dd, dd);
    // Steep luminosity function: most stars faint, a few bright.
    float mag = 0.04 + 12.0 * pow(h2.z, 30.0) + 0.5 * pow(h2.z, 6.0);
    float temp = mix(3000.0, 14000.0, pow(h.y, 2.2));
    star = blackbody(temp) * mag * gain * (STAR_SIGMA * STAR_SIGMA) / (sigma * sigma) * exp(-0.5 * ang2 / (sigma * sigma));
  }
  // Mean radiance of the layer: energy per star over the cell's solid angle.
  float meanMag = 0.04 + 12.0 / 31.0 + 0.5 / 7.0;
  vec3 mean = vec3(density * gain * meanMag * 6.2832 * STAR_SIGMA * STAR_SIGMA / (cellAngle * cellAngle));
  return mix(star, mean, smoothstep(0.08 * cellAngle, 0.25 * cellAngle, fp));
}

vec3 galaxy(vec3 d) {
  vec3 t1 = normalize(cross(GALAXY_DIR, vec3(0.0, 1.0, 0.0)));
  vec3 t2 = cross(t1, GALAXY_DIR);
  float c = dot(d, GALAXY_DIR);
  if (c < 0.9) return vec3(0.0);
  vec2 q = vec2(dot(d, t1), dot(d, t2)) / max(c, 1e-3);
  // Tilted elliptical galaxy with a warm core and bluer disk.
  float ca = cos(0.6), sa = sin(0.6);
  q = mat2(ca, -sa, sa, ca) * q;
  q.y *= 2.6;
  float rr = length(q);
  float core = exp(-rr / 0.0035);
  float disk = exp(-rr / 0.016) * (0.7 + 0.3 * sin(atan(q.y, q.x) * 2.0 + rr * 260.0));
  return vec3(1.0, 0.86, 0.66) * core * 4.0 + vec3(0.62, 0.72, 1.0) * disk * 0.6;
}

vec3 milkyWay(vec3 d) {
  vec3 n = normalize(vec3(0.32, 0.88, -0.35));
  vec3 gc = normalize(cross(n, vec3(0.0, 0.0, 1.0)));
  float lat = dot(d, n);
  float band = exp(-lat * lat / (2.0 * 0.11 * 0.11));
  float bulge = exp(-pow(1.0 - dot(d, gc), 1.0) * 7.0) * exp(-lat * lat / (2.0 * 0.2 * 0.2));
  if (band + bulge < 1e-3) return vec3(0.0);
  float clouds = 0.5 + 0.5 * fbm(d * 7.0, 4);
  float dust = smoothstep(0.05, 0.35, fbm(d * 16.0 + 4.0, 4) + 0.15) * exp(-lat * lat / (2.0 * 0.035 * 0.035));
  vec3 col = mix(vec3(0.42, 0.5, 0.78), vec3(1.0, 0.78, 0.55), clamp(bulge * 1.6, 0.0, 1.0));
  return col * (band * clouds * 0.05 + bulge * 0.09) * (1.0 - 0.85 * dust);
}

vec3 sky(vec3 d, float fp) {
  vec3 c = milkyWay(d);
  c += starLayer(d, 70.0, 0.6, 1.0, fp, 0);
  c += starLayer(d, 180.0, 0.6, 0.3, fp, 1);
  c += starLayer(d, 420.0, 0.6, 0.1, fp, 2);
  c += galaxy(d);
  return c;
}

// ---------------------------------------------------------------- main

// Guide circles in the equatorial plane (lensed images of r = const).
vec3 guideColour(float r) {
  vec3 c = vec3(1.0, 0.25, 0.2) * (1.0 - smoothstep(0.0, 0.03, abs(r - u_guideR.x - 0.015)));
  c += vec3(1.0, 0.75, 0.25) * (1.0 - smoothstep(0.0, 0.035, abs(r - u_guideR.y)));
  c += vec3(1.0, 0.75, 0.25) * (1.0 - smoothstep(0.0, 0.035, abs(r - u_guideR.z)));
  c += vec3(0.3, 0.85, 1.0) * (1.0 - smoothstep(0.0, 0.06, abs(r - u_guideR.w)));
  return c * 0.8;
}

void main() {
  vec2 ndc = v_uv * 2.0 - 1.0;
  vec3 dir = normalize(u_camForward + ndc.x * u_tan.x * u_camRight + ndc.y * u_tan.y * u_camUp);
  bool gr = u_lensing && ndc.x < u_split;

  vec3 acc = vec3(0.0);
  float transmit = 1.0;
  int fate = 0;          // 0 = out of steps, 1 = captured, 2 = escaped, 3 = absorbed by the disk
  vec3 escDir = vec3(0.0);
  bool hitDisk = false;
  float diskOn = u_disk ? 1.0 : 0.0;
  float r0 = length(u_camPos);

#if KERR
  if (gr) {
    // Photon momentum from the camera's local frame, normalised to p_t = -1.
    vec3 n = normalize(vec3(ndc.x * u_tan.x, ndc.y * u_tan.y, 1.0));
    vec4 P = u_kU + n.x * u_kR + n.y * u_kUp + n.z * u_kF;
    vec3 q = u_kPos;
    vec3 p = P.yzw / (-P.x);
    // l = L_z/E of the physical photon (the traced ray is its time reverse).
    float ell = -(q.z * p.x - q.x * p.z);
    vec3 dq;
    vec3 dp;
    float r = kerrRhs(q, p, u_spin, dq, dp);
    for (int i = 0; i < MAX_STEPS_HARD; i++) {
      if (i >= u_maxSteps) break;
      float h = kerrStepSize(r, length(dq), u_rH, u_hK);
      vec3 qn = q;
      vec3 pn = p;
      kerrRk4(qn, pn, dq, dp, h, u_spin);
      vec3 dqn;
      vec3 dpn;
      float rn = kerrRhs(qn, pn, u_spin, dqn, dpn);
      if (q.y * qn.y < 0.0) {
        // Equatorial crossing: locate it on the cubic Hermite interpolant of the step.
        float t = hermiteRoot(q.y, qn.y, h * dq.y, h * dqn.y);
        vec3 X = hermite3(q, qn, h * dq, h * dqn, t);
        float rc = sqrt(max(0.0, X.x * X.x + X.z * X.z - u_spin * u_spin));
        if (u_guides) acc += transmit * guideColour(rc);
        if (diskOn > 0.0 && rc > u_rIn && rc < DISK_OUTER) {
          vec4 d = shadeDisk(X, rc, ell, r0);
          acc += transmit * d.rgb;
          transmit *= 1.0 - d.a;
          hitDisk = true;
          if (transmit < 0.004) { fate = 3; break; }
        }
      }
      q = qn;
      p = pn;
      dq = dqn;
      dp = dpn;
      r = rn;
      if (r < u_rH + CAPTURE_MARGIN) { fate = 1; break; }
      if (r > R_ESCAPE && dot(q, dq) > 0.0) {
        fate = 2;
        escDir = normalize(dq);
        break;
      }
    }
  } else
#endif
  {
    // Orbit plane: e1 towards the camera (phi = 0), e2 along the ray's sideways part.
    vec3 e1 = u_camPos / r0;
    float cosA = dot(dir, e1);
    vec3 perp = dir - cosA * e1;
    float sinA = length(perp);
    vec3 e2;
    if (sinA < 1e-7) {
      vec3 helper = abs(e1.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      e2 = normalize(cross(cross(e1, helper), e1));
      sinA = 1e-7;
    } else {
      e2 = perp / sinA;
    }
    float u = 1.0 / r0;
    float lapse = gr ? sqrt(1.0 - R_S * u) : 1.0;
    float w = -u * lapse * cosA / sinA;
    float b = r0 * sinA / lapse;
    // Photon angular momentum about the disk axis (+y), per unit energy. The
    // traced ray runs backwards along +phi, so the real photon has L = -b (e1 x e2).
    float ell = -b * cross(e1, e2).y;
    // Straight rays stop at the horizon of the hole being drawn.
    float uCapture = gr ? 1.0 / R_S : 1.0 / u_rCapture;

    // Equatorial crossings are exactly pi apart in phi.
    float nextCross = 1e9;
    if (abs(e1.y) > 1e-9 || abs(e2.y) > 1e-9) {
      nextCross = atan(-e1.y, e2.y);
      if (nextCross <= 1e-6) nextCross += PI;
      if (nextCross <= 1e-6) nextCross += PI;
    }

    float phi = 0.0;
    for (int i = 0; i < MAX_STEPS_HARD; i++) {
      if (i >= u_maxSteps) break;
      float h = stepSize(u, w);
      bool onCross = false;
      if (phi + h >= nextCross) {
        h = nextCross - phi;
        onCross = true;
      }
      rk4(u, w, h, gr);
      phi += h;
      if (u >= uCapture) { fate = 1; break; }
      if (onCross) {
        nextCross += PI;
        float r = 1.0 / u;
        vec3 P = r * (cos(phi) * e1 + sin(phi) * e2);
        if (u_guides) acc += transmit * guideColour(r);
        if (diskOn > 0.0 && r > u_rIn && r < DISK_OUTER) {
          vec4 d = shadeDisk(P, r, ell, r0);
          acc += transmit * d.rgb;
          transmit *= 1.0 - d.a;
          hitDisk = true;
          if (transmit < 0.004) { fate = 3; break; }
        }
      }
      if (u < 1.0 / R_ESCAPE && w < 0.0) {
        fate = 2;
        float phiInf = phi + asin(clamp(b * u, 0.0, 1.0));
        escDir = cos(phiInf) * e1 + sin(phiInf) * e2;
        break;
      }
    }
  }

  // Angular footprint of this pixel on the sky after lensing (uniform control flow).
  float fp = length(fwidth(escDir));

  if (u_debug) {
    // Linear values chosen to land on 255/0 after tone mapping, for easy measurement.
    vec3 c = fate == 1 ? vec3(8.0, 0.0, 0.0) : fate == 2 ? vec3(0.0, 8.0, 0.0) : fate == 3 ? vec3(0.0, 0.0, 8.0) : vec3(8.0, 0.0, 8.0);
    if (hitDisk && fate == 2) c = vec3(0.0, 8.0, 8.0);
    outColor = vec4(c, 1.0);
    return;
  }

  if (fate == 2 && transmit > 0.004) acc += transmit * sky(escDir, fp);
  outColor = vec4(acc * u_outScale, 1.0);
}
