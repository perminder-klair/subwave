import type { CandidateMatch, MatcherPlugin } from "deepsec/config";
import { regexMatcher } from "deepsec/config";

/**
 * Shell that renders config or reads controller-written state.
 *
 * deepsec ships no matcher for `.sh`, so without this the broadcast
 * entrypoint and the AIO supervisor are never candidates — and they are
 * where settings-derived values (Icecast passwords, trusted-proxy IPs,
 * listener-auth URL, mount sizes) are spliced into `icecast.xml` with
 * `sed` and `echo`. A value carrying the sed delimiter, a `&`, a quote or
 * a `<` rewrites the rendered config. The state dir is written by the
 * controller, so a file read back from it is input, not constant.
 *
 * Both copies (entrypoint + supervisor) duplicate the render on purpose;
 * a finding in one almost always applies to the other.
 */
export const subwaveShellRender: MatcherPlugin = {
  slug: "subwave-shell-render",
  description: "Shell rendering config/markers from variables, or reading controller-written state",
  noiseTier: "normal",
  filePatterns: ["docker/**/*.sh", "scripts/*.sh", "controller/scripts/*.sh", "install.sh"],
  examples: [
    `    -e "s|\\\${ICECAST_SOURCE_PASSWORD}|$ICECAST_SOURCE_PASSWORD|g" \\`,
    `sed -i "s/@HOST@/$HOST/" "$CONF"`,
    `        echo "        <mount-name>$1</mount-name>"`,
    `    if printf '{"count":%s,"source":"%s"}\\n' "$n" "$src" > "$tmp"; then`,
    `cat > "$SECRETS" <<EOF`,
    `\tcat > "$SECRETS" <<-EOF`,
    `    _v=$(cat "$STATE_DIR/$1" 2>/dev/null || true)`,
    `id=$(sed -n 's/x/y/p' "$active" | head -n1)`,
    `eval "$line"`,
    `curl -fsSL https://example.com/install.sh | sh`,
    `wget -qO- https://example.com/x | sudo bash`,
  ],
  match(content, filePath): CandidateMatch[] {
    // Audio render harnesses, not deployed code.
    if (/-test\.sh$/.test(filePath)) return [];
    return regexMatcher(
      "subwave-shell-render",
      [
        {
          // "s<delim>…<delim>…$VAR" — an unescaped expansion inside a double-quoted
          // sed expression. Single-quoted ones never expand, so they are not matched.
          regex: /"s([|/#@,])[^"]*?\1[^"]*?(?<!\\)\$\{?[A-Za-z_]/,
          label: "sed substitution interpolating a shell variable",
        },
        {
          regex: /\b(?:echo|printf)\b.*<[A-Za-z!?/][^>]*>?.*(?<!\\)\$\{?[A-Za-z_0-9]/,
          label: "echo/printf emitting XML with an interpolated value",
        },
        {
          regex: /\bprintf\s+(?:'[^']*[{[][^']*%s|"[^"]*[{[][^"]*%s)/,
          label: "printf emitting JSON with an unescaped %s",
        },
        {
          // Unquoted delimiter = the body is expanded. <<'EOF' is literal and not matched.
          regex: />\s*\S+\s*<<-?\s*[A-Za-z_]\w*\s*$/,
          label: "unquoted heredoc (body is expanded) written to a file",
        },
        {
          regex: /\$\(\s*(?:cat|sed|head|tail|tr|awk|jq)\b[^)]*"\$\{?[A-Za-z_]/,
          label: "value read from a file named by a variable",
        },
        { regex: /(?:^|[;&|(]\s*|\s)eval\s/, label: "eval" },
        {
          regex: /\b(?:curl|wget)\b[^|#]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da)?sh\b/,
          label: "download piped to a shell",
        },
      ],
      content,
    );
  },
};
