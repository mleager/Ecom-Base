package reconcilecmd

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"io"
	"strings"
	"testing"
)

func TestFlags(t *testing.T) {
	for _, tc := range []struct {
		args  []string
		apply bool
		limit int
		bad   bool
	}{
		{nil, false, 100, false},
		{[]string{"--dry-run", "--limit", "1"}, false, 1, false},
		{[]string{"--apply", "--limit=1000"}, true, 1000, false},
		{[]string{"--apply", "--dry-run"}, false, 0, true},
		{[]string{"--apply=false", "--dry-run"}, false, 0, true},
		{[]string{"--limit=0"}, false, 0, true},
		{[]string{"--limit=1001"}, false, 0, true},
		{[]string{"--limit=private-secret"}, false, 0, true},
		{[]string{"--unknown=private-secret"}, false, 0, true},
		{[]string{"--limit"}, false, 0, true},
		{[]string{"extra"}, false, 0, true},
	} {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			var help bytes.Buffer
			options, err := Parse(tc.args, &help)
			if (err != nil) != tc.bad || (!tc.bad && (options.Apply != tc.apply || options.Limit != tc.limit)) {
				t.Fatalf("options=%+v err=%v", options, err)
			}
			if help.Len() > 0 || (err != nil && strings.Contains(err.Error(), "private-secret")) {
				t.Fatal("flag error leaked its input")
			}
		})
	}
	var help bytes.Buffer
	if _, err := Parse([]string{"--help"}, &help); !errors.Is(err, flag.ErrHelp) || help.Len() == 0 {
		t.Fatal("help missing")
	}
	if err := Run(context.Background(), []string{"--help"}, func(string) string { t.Fatal("help read environment"); return "" }, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
}
