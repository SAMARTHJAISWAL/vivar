#version 300 es
// 3x3 tent upsample; blended additively onto the next larger mip.
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_src;
uniform vec2 u_texel;
uniform float u_radius;
uniform float u_weight;

void main() {
  vec2 o = u_texel * u_radius;
  vec3 s = texture(u_src, v_uv).rgb * 4.0;
  s += (texture(u_src, v_uv + vec2(-o.x, 0)).rgb + texture(u_src, v_uv + vec2(o.x, 0)).rgb
      + texture(u_src, v_uv + vec2(0, -o.y)).rgb + texture(u_src, v_uv + vec2(0, o.y)).rgb) * 2.0;
  s += texture(u_src, v_uv + vec2(-o.x, -o.y)).rgb + texture(u_src, v_uv + vec2(o.x, -o.y)).rgb
     + texture(u_src, v_uv + vec2(-o.x, o.y)).rgb + texture(u_src, v_uv + vec2(o.x, o.y)).rgb;
  outColor = vec4(s * (u_weight / 16.0), 1.0);
}
