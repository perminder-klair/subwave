# Select complete dotenv assignments from ARGV[2] whose keys are absent from
# ARGV[1]. Only inspect keys and quote boundaries; Compose interprets the values.

function scan_quotes(text, start,    i, char) {
    for (i = start; i <= length(text); i++) {
        char = substr(text, i, 1)
        if (char == "\\") {
            i++
        } else if (char == quote) {
            quote = ""
            return
        }
    }
}

function finish_record() {
    if (FILENAME == ARGV[1]) {
        root_keys[key] = 1
    } else if (!(key in root_keys) && key !~ /^ICECAST_/) {
        merged = merged record "\n"
    }
    record = ""
}

FNR == 1 && quote != "" {
    invalid = 1
    exit 2
}

{
    if (quote != "") {
        record = record "\n" $0
        scan_quotes($0, 1)
    } else {
        assignment = $0
        sub(/^[[:space:]]+/, "", assignment)
        sub(/^export[[:space:]]+/, "", assignment)
        if (assignment !~ /^[^#=[:space:]]+[[:space:]]*=/) next
        key = assignment
        sub(/=.*/, "", key)
        sub(/[[:space:]]+$/, "", key)
        value = assignment
        sub(/^[^=]*=[[:space:]]*/, "", value)
        record = $0
        first = substr(value, 1, 1)
        if (first == "\"" || first == sprintf("%c", 39)) {
            quote = first
            scan_quotes(value, 2)
        }
    }
    if (quote == "") finish_record()
}

END {
    if (invalid || quote != "") {
        print "[prep] cannot merge an unterminated quoted dotenv value" > "/dev/stderr"
        exit 2
    }
    printf "%s", merged
}
