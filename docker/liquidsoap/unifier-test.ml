(* Exercise the actual upstream module, compiled beside this file by build.sh.
   Structural assertions avoid a timing threshold that depends on CI speed. *)
open Unifier

let depth value =
  let rec walk n = function
    | `Value _ -> n
    | `Link a -> walk (n + 1) (Atomic.get a)
  in
  walk 0 value

let chain n =
  let first = make 0 in
  let last = ref first in
  for i = 1 to n do
    let next = make i in
    !last <-- next;
    last := next
  done;
  (first, !last)

let () =
  let first, last = chain 1_000_000 in
  assert (deref first = 1_000_000);
  assert (depth first = 2);
  set first 42;
  assert (deref last = 42);
  last <-- first;
  first <-- first;
  assert (deref first = 42);
  let a, b = chain 10_000 in
  set a 7;
  assert (depth a = 2);
  assert (deref b = 7);
  let c, d = chain 10_000 in
  a <-- c;
  assert (depth c = 2);
  assert (deref a = 10_000);
  set d 99;
  assert (deref a = 99);
  assert (deref b = 99);
  assert (deref (`Value 123) = 123);
  print_endline "unifier: million-link compression and alias semantics passed"
