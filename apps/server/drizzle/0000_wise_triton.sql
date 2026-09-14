CREATE TABLE "arena_entries" (
	"id" bigint PRIMARY KEY NOT NULL,
	"arena_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"score" integer NOT NULL,
	"is_conquered" boolean DEFAULT false NOT NULL,
	"words" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "arenas" (
	"id" integer PRIMARY KEY NOT NULL,
	"passage_id" integer NOT NULL,
	"position" integer NOT NULL,
	"content" text NOT NULL,
	"stars" integer NOT NULL,
	"word_count" integer NOT NULL,
	"expected_speech_ms" integer NOT NULL,
	"participant_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" bigint PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" varchar(16) NOT NULL,
	"amount" integer NOT NULL,
	"out_trade_no" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payments_out_trade_no_unique" UNIQUE("out_trade_no")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"openid" varchar(64) NOT NULL,
	"unionid" varchar(64),
	"nickname" varchar(64),
	"avatar_url" varchar(512),
	"subscription_end" timestamp,
	"next_free_at" timestamp DEFAULT now() NOT NULL,
	"invalid_count" integer DEFAULT 0 NOT NULL,
	"invalid_date" varchar(10),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_openid_unique" UNIQUE("openid")
);
--> statement-breakpoint
ALTER TABLE "arena_entries" ADD CONSTRAINT "arena_entries_arena_id_arenas_id_fk" FOREIGN KEY ("arena_id") REFERENCES "public"."arenas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arena_entries" ADD CONSTRAINT "arena_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entries_rank_idx" ON "arena_entries" USING btree ("arena_id","score","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "entries_user_arena_idx" ON "arena_entries" USING btree ("arena_id","user_id");--> statement-breakpoint
CREATE INDEX "arenas_passage_idx" ON "arenas" USING btree ("passage_id");