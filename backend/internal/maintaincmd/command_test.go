package maintaincmd

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"io"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	for _, tc := range []struct {
		args    []string
		batches int
		bad     bool
	}{
		{[]string{"guests"}, 20, false},
		{[]string{"guests", "--max-batches", "1"}, 1, false},
		{[]string{"guests", "--max-batches=1000"}, 1000, false},
		{nil, 0, true},
		{[]string{"orders"}, 0, true},
		{[]string{"guests", "--max-batches=0"}, 0, true},
		{[]string{"guests", "--max-batches=1001"}, 0, true},
		{[]string{"guests", "--max-batches=private-secret"}, 0, true},
		{[]string{"guests", "--unknown=private-secret"}, 0, true},
		{[]string{"guests", "extra"}, 0, true},
	} {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			var help bytes.Buffer
			batches, err := Parse(tc.args, &help)
			if (err != nil) != tc.bad || batches != tc.batches {
				t.Fatalf("batches=%d err=%v", batches, err)
			}
			if help.Len() > 0 || (err != nil && strings.Contains(err.Error(), "private-secret")) {
				t.Fatal("flag error leaked its input")
			}
		})
	}
	for _, args := range [][]string{{"--help"}, {"guests", "--help"}} {
		var help bytes.Buffer
		if _, err := Parse(args, &help); !errors.Is(err, flag.ErrHelp) || help.Len() == 0 {
			t.Fatalf("%v: help missing", args)
		}
	}
	if err := Run(context.Background(), []string{"--help"}, func(string) string { t.Fatal("help read environment"); return "" }, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
}
