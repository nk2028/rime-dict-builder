# rime-dict-builder

Build [rime-tupa](https://github.com/ayaka14732/rime-tupa)/[rime-kyonh](https://github.com/ayaka14732/rime-kyonh) dicts from [rime-dict-source](https://github.com/nk2028/rime-dict-source).

(NOTE: requires beta version of Qieyun.js & qieyun-examples, and "v2" branch of rime-dict-source)

Usage:

1.  Prepare

    ```sh
    npm i
    ```

2.  `cd` to dir containing `{tupa,kyonh}.schema.dict`

    ```sh
    node <path to rime-dict-builder>/build.js
    # add `--help` to see available options
    ```
