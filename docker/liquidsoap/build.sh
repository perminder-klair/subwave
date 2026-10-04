#!/bin/sh
set -eu

# The builder image pins the compiler, native libraries and OCaml bindings.
# Do not run opam update or liquidsoap-full's make update here.
eval "$(opam env)"
export LIQUIDSOAP_BUILD_TARGET=posix
export IS_SNAPSHOT=false
export DUNE_PROFILE=release
export DUNE_JOBS=4

cd /tmp/liquidsoap-full/liquidsoap
git fetch --depth=1 origin d2bf3eb209391815e8d6a84b6cbf7ad4168d703d
git checkout --detach FETCH_HEAD
git apply --check /patch/unifier-path-compression.patch
git apply /patch/unifier-path-compression.patch
echo '3dec46819206450226cbe74ea0920116834a8075d63f220179e61fd5554412ad  src/lang/base/unifier.ml' | sha256sum -c -

mkdir -p /tmp/unifier-test /tmp/out
git show HEAD:src/lang/base/unifier.ml > /tmp/unifier-test/unifier.ml
cp /patch/unifier-test.ml /tmp/unifier-test/unifier_test.ml
(cd /tmp/unifier-test && ocamlopt -o stock-test unifier.ml unifier_test.ml)
if /tmp/unifier-test/stock-test > /tmp/unifier-test/stock.log 2>&1; then
    echo 'Regression test unexpectedly passed on stock 2.4.5' >&2
    exit 1
fi
grep -q Assert_failure /tmp/unifier-test/stock.log
cp src/lang/base/unifier.ml /tmp/unifier-test/
(cd /tmp/unifier-test && ocamlopt -o test unifier.ml unifier_test.ml && ./test)

# Match the FFmpeg binding revision used by the v2.4.5 release job.
cd /tmp/liquidsoap-full/ocaml-ffmpeg
git fetch --depth=1 origin 49c9545a964ea32429569e0803f7f2a0cc8e19db
git checkout --detach FETCH_HEAD

# Build the binding sources already present in the pinned upstream builder.
# Keep every optional codec: the final binary must parse all radio.liq branches.
cd /tmp/liquidsoap-full
export OCAMLPATH=""
for package in $(sed -n '/^ocaml/p' PACKAGES.default | awk '!seen[$0]++'); do
    cd "/tmp/liquidsoap-full/$package"
    if [ "$package" = ocaml-xiph ]; then
        # Upstream 2.4.5 omits deprecated Speex/Theora too.
        dune build --profile=release -j 4 -p ogg,vorbis,opus,flac @install
    else
        dune build --profile=release -j 4 @install
    fi
    OCAMLPATH="$PWD/_build/install/default/lib:$OCAMLPATH"
    export OCAMLPATH
done
cd /tmp/liquidsoap-full/liquidsoap
dune build --profile=release -j 4 src/bin/liquidsoap.exe
cp _build/default/src/bin/liquidsoap.exe /tmp/out/liquidsoap
/tmp/out/liquidsoap --build-config > /tmp/out/build-config.txt
opam list --installed > /tmp/out/opam-packages.txt
for package in /tmp/liquidsoap-full/ocaml-*; do
    printf '%s ' "$(basename "$package")"
    git -C "$package" rev-parse HEAD
done > /tmp/out/binding-sources.txt
printf '%s\n' 'Liquidsoap v2.4.5 (d2bf3eb209391815e8d6a84b6cbf7ad4168d703d)' \
    'Upstream patch: de68528a87d0cd2137b6dd53abf0110d21974ad3 (#5257)' > /tmp/out/source.txt
