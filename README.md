# kromosynth render

Rendering servers (WebSocket), accepting URLs to genomes, or the genomes as a string, and returning a rendered sound.

Currently there are two server variants, rendering sounds with the kromosynth CPPN+DSP synthesis approach (CSSN): one returning PCM (integer) data (`socket-server-pcm.js`), used by synth.is/evoruns-explorer; the other returning the rendered audio buffers as arrays of floating point numbers (supported by another websocket implementation, `ws`), used by evoruns controlled by `kromosynth-cli`, when configured to communicate with (distributed) websocket servers.

[![DOI](https://zenodo.org/badge/662273306.svg)](https://zenodo.org/doi/10.5281/zenodo.10228908)
