// Keep whitespace and empty rows in the form while typing. Trimming here
// removes a newly typed newline before the operator can enter the next line.
// The shared persona schema cleans the lines at the save boundary.
export function identLinesFromText(text: string): string[] {
  return text.split('\n');
}
