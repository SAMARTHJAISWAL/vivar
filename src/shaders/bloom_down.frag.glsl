#version 300 es
// 13-tap downsample (Jimenez, "Next Generation Post Processing in Call of
// Duty: Advanced Warfare", SIGGRAPH 2014). On the first pass it also applies a
// soft brightness threshold and a Karis average to suppress fireflies.
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_src;
uniform vec2 u_texel;      // 1 / source size
uniform bool u_prefilter;
uniform float u_threshold;
uniform float u_knee;

vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - u_threshold + u_knee, 0.0, 2.0 * u_knee);
  soft = soft * soft / (4.0 * u_knee + 1e-5);
  float contrib = max(soft, br - u_threshold) / max(br, 1e-5);
  return c * contrib;
}

float karis(vec3 c) { return 1.0 / (1.0 + max(c.r, max(c.g, c.b))); }

vec3 tap(vec2 o) { return texture(u_src, v_uv + o * u_texel).rgb; }

void main() {
  vec3 a = tap(vec2(-2, 2)), b = tap(vec2(0, 2)), c = tap(vec2(2, 2));
  vec3 d = tap(vec2(-2, 0)), e = tap(vec2(0, 0)), f = tap(vec2(2, 0));
  vec3 g = tap(vec2(-2, -2)), h = tap(vec2(0, -2)), i = tap(vec2(2, -2));
  vec3 j = tap(vec2(-1, 1)), k = tap(vec2(1, 1)), l = tap(vec2(-1, -1)), m = tap(vec2(1, -1));
  vec3 res;
  if (u_prefilter) {
    vec3 g0 = (j + k + l + m) * 0.25;
    vec3 g1 = (a + b + d + e) * 0.25;
    vec3 g2 = (b + c + e + f) * 0.25;
    vec3 g3 = (d + e + g + h) * 0.25;
    vec3 g4 = (e + f + h + i) * 0.25;
    float w0 = karis(g0) * 0.5, w1 = karis(g1) * 0.125, w2 = karis(g2) * 0.125, w3 = karis(g3) * 0.125, w4 = karis(g4) * 0.125;
    res = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    res = prefilter(res);
  } else {
    res = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  outColor = vec4(res, 1.0);
}
