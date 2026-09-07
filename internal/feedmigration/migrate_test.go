package feedmigration

import "testing"

func TestEmbeddedMigrationsAreOrdered(t *testing.T) {
	items, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) < 2 {
		t.Fatalf("migration count = %d", len(items))
	}
	for index := 1; index < len(items); index++ {
		if items[index-1].version >= items[index].version {
			t.Fatalf("not ordered: %#v", items)
		}
	}
}

func TestLatestVersionMatchesEmbeddedMigrationLedger(t *testing.T) {
	items, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	latest, err := LatestVersion()
	if err != nil {
		t.Fatal(err)
	}
	if latest != items[len(items)-1].version {
		t.Fatalf("latest version=%d, final embedded migration=%d", latest, items[len(items)-1].version)
	}
	required, err := RequiredMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if len(required) != len(items) {
		t.Fatalf("required migration count=%d, embedded=%d", len(required), len(items))
	}
	for index, item := range items {
		if required[index].Version != item.version || required[index].Name != item.name {
			t.Fatalf("required[%d]=%#v, embedded=%#v", index, required[index], item)
		}
	}
}
