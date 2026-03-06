# Shell Completions

bsky-cli can generate completion scripts for bash, zsh, and fish. Tab completion makes discovering commands and flags much faster.

## Setup

=== "Bash"

    ```bash
    bsky completions bash >> ~/.bashrc
    source ~/.bashrc
    ```

=== "Zsh"

    ```bash
    bsky completions zsh >> ~/.zshrc
    source ~/.zshrc
    ```

=== "Fish"

    ```bash
    bsky completions fish > ~/.config/fish/completions/bsky.fish
    ```

## Usage

After installing completions, press ++tab++ to complete commands and flags:

```
bsky t<TAB>        → bsky timeline / bsky thread
bsky post --<TAB>  → --stdin --image --image-alt --video --video-alt
bsky stream --p<TAB> → --pattern --pattern-flags --profile
```

## Updating completions

When you upgrade bsky-cli, regenerate the completion script to pick up new commands and flags:

=== "Bash"

    ```bash
    bsky completions bash > /tmp/bsky.bash && mv /tmp/bsky.bash ~/.bashrc
    ```

    !!! note
        If you have other content in `~/.bashrc`, append with `>>` instead of overwriting with `>`. Alternatively, source a separate file:

        ```bash
        bsky completions bash > ~/.bsky-completions.bash
        echo 'source ~/.bsky-completions.bash' >> ~/.bashrc
        ```

=== "Zsh"

    ```bash
    bsky completions zsh > ~/.bsky-completions.zsh
    echo 'source ~/.bsky-completions.zsh' >> ~/.zshrc
    ```

=== "Fish"

    ```bash
    bsky completions fish > ~/.config/fish/completions/bsky.fish
    ```

    Fish reloads completions automatically — no restart needed.
