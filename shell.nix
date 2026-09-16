{
  pkgs ? import <nixpkgs> { },
}:

pkgs.mkShell {

  # Bun, not node: OpenTUI reaches its Zig core through Bun's FFI, and node
  # needs >= 26.4 with --experimental-ffi.
  buildInputs = [
    pkgs.bun
    pkgs.just
  ];

  shellHook = ''
    alias mock="bun run src/main.tsx"
  '';
}
