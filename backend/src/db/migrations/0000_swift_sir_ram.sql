CREATE TYPE "public"."payment_status" AS ENUM('pending', 'success', 'refunded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."subscription_type" AS ENUM('single', 'monthly', 'yearly');--> statement-breakpoint
CREATE TABLE "articles" (
	"id" serial PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"translation" varchar(1024),
	"difficulty" numeric(2, 1) NOT NULL,
	"d_len" numeric(2, 1) DEFAULT '0' NOT NULL,
	"d_vocab" numeric(2, 1) DEFAULT '0' NOT NULL,
	"d_syntax" numeric(2, 1) DEFAULT '0' NOT NULL,
	"word_count" integer NOT NULL,
	"source_type" varchar(32) DEFAULT 'quote' NOT NULL,
	"author" varchar(128),
	"publish_date" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" bigint PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" "subscription_type" NOT NULL,
	"channel" varchar(16) DEFAULT 'alipay' NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"article_id" integer,
	"trade_no" varchar(128),
	"out_trade_no" varchar(128) NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"paid_at" timestamp,
	CONSTRAINT "payments_out_trade_no_unique" UNIQUE("out_trade_no")
);
--> statement-breakpoint
CREATE TABLE "pronunciation_tips" (
	"id" serial PRIMARY KEY NOT NULL,
	"word" varchar(64) NOT NULL,
	"error_type" varchar(32) NOT NULL,
	"correct_phoneme" varchar(32),
	"user_phoneme" varchar(32),
	"tip" text NOT NULL,
	"hit_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "readings" (
	"id" bigint PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"article_id" integer NOT NULL,
	"quality_score" numeric(4, 1) NOT NULL,
	"experience_gained" integer DEFAULT 0 NOT NULL,
	"proficiency_before" numeric(4, 1),
	"proficiency_after" numeric(4, 1),
	"is_paid" boolean DEFAULT false NOT NULL,
	"is_best" boolean DEFAULT false NOT NULL,
	"error_detail" jsonb,
	"ai_suggestions" jsonb,
	"audio_duration" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_article_status" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"article_id" integer NOT NULL,
	"best_score" numeric(4, 1) DEFAULT '0' NOT NULL,
	"is_conquered" boolean DEFAULT false NOT NULL,
	"is_perfect" boolean DEFAULT false NOT NULL,
	"is_unlocked" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"first_read_at" timestamp DEFAULT now() NOT NULL,
	"best_read_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"nickname" varchar(64),
	"proficiency_score" numeric(4, 1) DEFAULT '0' NOT NULL,
	"total_experience" integer DEFAULT 0 NOT NULL,
	"honor_title" varchar(32) DEFAULT '朗读者' NOT NULL,
	"streak_days" integer DEFAULT 0 NOT NULL,
	"last_read_at" timestamp,
	"subscription_end" timestamp,
	"daily_submissions_left" integer DEFAULT 5 NOT NULL,
	"daily_reset_date" date NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readings" ADD CONSTRAINT "readings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readings" ADD CONSTRAINT "readings_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_article_status" ADD CONSTRAINT "user_article_status_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_article_status" ADD CONSTRAINT "user_article_status_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;