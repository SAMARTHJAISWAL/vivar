#version 300 es
// Final pass at full canvas resolution: upsample the scene, add bloom,
// expose, tone-map (ACES fit), encode sRGB, dither. Also draws the
// screen-space overlays (predicted shadow edge, split divider).
precision highp float;
//#include constants
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_exposure;      // linear multiplier, 2^EV
uniform float u_bloomStrength;
uniform float u_sceneScale;    // decode factor for an LDR scene buffer (1 for float buffers)
uniform vec2 u_resolution;     // canvas size, px
uniform vec3 u_camForward;
uniform vec3 u_camRight;
uniform vec3 u_camUp;
uniform vec2 u_tan;
uniform float u_shadowAngle;   // predicted shadow angular radius, radians (<0 hides)
uniform float u_split;         // NDC x of split line (> 1 hides)
uniform float u_time;

// Krzysztof Narkowicz's fit of the ACES filmic curve (2016).
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Interleaved gradient noise (Jimenez 2014) for dithering.
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main() {
  vec3 hdr = texture(u_scene, v_uv).rgb * u_sceneScale;
  hdr += texture(u_bloom, v_uv).rgb * u_sceneScale * u_bloomStrength;
  vec3 c = toSrgb(aces(hdr * u_exposure));

  vec2 ndc = v_uv * 2.0 - 1.0;
  if (u_shadowAngle > 0.0) {
    vec3 dir = normalize(u_camForward + ndc.x * u_tan.x * u_camRight + ndc.y * u_tan.y * u_camUp);
    float ang = acos(clamp(dot(dir, u_camForward), -1.0, 1.0));
    float pix = 2.0 * u_tan.y / u_resolution.y;          // approx. radians per pixel near the centre
    float line = 1.0 - smoothstep(0.6 * pix, 1.6 * pix, abs(ang - u_shadowAngle));
    float around = atan(dot(dir, u_camUp), dot(dir, u_camRight));
    float dash = step(0.5, fract(around * 18.0 / PI));
    c = mix(c, vec3(0.92, 0.95, 1.0), line * dash * 0.85);
  }
  if (u_split <= 1.0) {
    float px = abs(ndc.x - u_split) * 0.5 * u_resolution.x;
    c = mix(c, vec3(0.85, 0.9, 1.0), (1.0 - smoothstep(0.5, 1.5, px)) * 0.7);
  }

  c += (ign(gl_FragCoord.xy + fract(u_time) * 97.0) - 0.5) / 255.0;
  outColor = vec4(c, 1.0);
}
