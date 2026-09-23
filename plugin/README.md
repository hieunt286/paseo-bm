# paseo-bm-plugin — the paseo-bm payload

This package is the **plugin payload** of [paseo-bm](https://github.com/hieunt286/paseo-bm): the
screens it contributes to [Paseo](https://paseo.sh) and the instructions its three agent roles run
on. Loading it gives you **Metric** (what each request did and cost), **Beads** (the workspace's
beads) and **Setup** (tools, skills and role instructions).

![The Beads screen: totals, progress, filters and the bead list](images/01-beads-screen.jpg)

## Install paseo-bm with `npx paseo-bm`

```bash
npx paseo-bm
```

That is the supported install, and it is what you want. The installer copies this payload to a
stable path, registers it with the Paseo daemon, **registers the three agent roles** `bm-manager`,
`bm-worker` and `bm-reviewer`, and asks for the consent those roles need.

## Limitations of installing this package directly

You can point Paseo at this payload on its own:

```bash
# Paseo 0.9 and newer — npm source
paseo plugin add npm:paseo-bm-plugin@<version>

# Paseo 0.8 — Git source; 0.8 has no npm source type
paseo plugin add hieunt286/paseo-bm --ref <commit> --path plugin
```

Either way the plugin **loads and the screens appear, but the three agent roles are missing**,
because the installer registers them, not the payload. Without those roles the Beads Manager cannot
create a Worker, so the product does not work end to end. Use `npx paseo-bm` instead.

Everything else worth knowing before you install — what paseo-bm writes on your machine, that Paseo
plugins run without a sandbox, and that the Worker runs without permission prompts — is in
[GUIDE.md](https://github.com/hieunt286/paseo-bm/blob/main/GUIDE.md#before-you-install-read-these-warnings).

## Versions

This package always carries the same version as the `paseo-bm` CLI, published from the same commit
in the same release.

## Documentation

- [Repository and README](https://github.com/hieunt286/paseo-bm#readme)
- [GUIDE.md](https://github.com/hieunt286/paseo-bm/blob/main/GUIDE.md) — requirements, install options, the screens, commands, exit codes, troubleshooting
- [Guided tour](https://paseo-bm.erai.pro)

## License

MIT, see [LICENSE](LICENSE).
