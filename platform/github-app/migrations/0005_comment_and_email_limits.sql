CREATE TABLE author_comment_once (
  installation INTEGER NOT NULL,
  repository INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (installation, repository, user_id)
);
CREATE TABLE noscore_comment_budget (
  installation INTEGER NOT NULL,
  repository INTEGER NOT NULL,
  used INTEGER NOT NULL,
  PRIMARY KEY (installation, repository)
);
