// Package fixtures embeds the cross-runtime scoring parity fixtures so Go
// consumers outside this repository (the private backend) can pin themselves
// to the exact cases the TypeScript and Python ports are tested against.
package fixtures

import "embed"

//go:embed *.json
var FS embed.FS
