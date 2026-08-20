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
