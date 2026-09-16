{
  description = "Darkone NixOS Framework — fleet update and deployment tool.";

  #----------------------------------------------------------------------------
  # FLAKE INPUTS
  #----------------------------------------------------------------------------
  #
  # Single input: nixpkgs, for the Bun toolchain of the dev shell. The published
  # package lives in `dnf/pkgs/fleet-update/package.nix`, not here.

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  #----------------------------------------------------------------------------
  # FLAKE OUTPUTS
  #----------------------------------------------------------------------------
  #
  # Dev shell only while the tool is a mockup: no derivation yet, the framework
  # packages the published version once the interface is validated.

  outputs =
    { nixpkgs, ... }:
    let

      supportedSystems = [
        "x86_64-linux"
        # "aarch64-linux"
      ];

      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;

    in
    {

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = import ./shell.nix { inherit pkgs; };
        }
      );
    };
}
