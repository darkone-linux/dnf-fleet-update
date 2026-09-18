// `--help` text: the options of the spec, grouped the same way.

export const HELP = `Usage: fleet-update [options]

Update, build and deploy a DNF fleet in waves.

Selection and order
  --on <query>                    hosts: names, globs, @tag or +profile, e.g. "gfx,gw-*" or "@zone-ag,+gateway"
  --deployment-order <profiles>   waves by profile (default "hcs:gateway:server:[others]:laptop")
  --critical-profiles <profiles>  profiles of critical hosts (default "hcs:gateway:server")
  --no-current-zone-before        do not test the current zone before the other zones

Update
  --no-dnf-flake                  skip "nix flake update" of dnf/ (co-development only)
  --no-consumer-flake             skip "nix flake update" of the consumer
  --dnf-message <msg>             dnf/ commit message (default "chore(update): regular flake upgrade")
  --consumer-message <msg>        consumer commit message (default "chore(update): full fleet" or "chore(update): <--on>")

Flow
  --build-only                    stop after the build; interactive: ask to continue
  --skip-test                     no test step: switch wave by wave, straight from the build
  --resume                        resume the last unfinished deployment
  --non-interactive               no confirmation (forced by --no-ui)
  --stop-loss                     non-interactive: a lost host stops the run and rolls the fleet back

Output
  --no-ui                         plain text output, forces --non-interactive
  --send-report                   send the report summary to the Matrix alert rooms

AI
  --ai-model <tool>[:<model>][@<effort>]   default "claude:opus@high"
  --ai-analysis none|passive|active        AI analysis and report (default "none")
  --ai-error-action none|analysis|repair   AI action on error (default "analysis")

Execution
  --max-parallel <n>              hosts copied and activated at once in a wave (default 10)
  --rollback-timeout <seconds>    automatic rollback of a host unreachable after activation (default 600, 0 = off)

Information
  --help                          this help
  --version                       published version
`;
