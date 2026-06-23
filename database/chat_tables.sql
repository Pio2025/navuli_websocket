-- ============================================================
-- Navuli Chat — Database Tables
-- Run this against your vbgwpgmy_navuli database
-- ============================================================

-- Tracks each conversation (direct 1-to-1 or group)
CREATE TABLE IF NOT EXISTS `chat_conversations` (
  `id`         INT(11)                       NOT NULL AUTO_INCREMENT,
  `type`       ENUM('direct','group')        NOT NULL DEFAULT 'direct',
  `name`       VARCHAR(255)                  DEFAULT NULL,
  `created_by` INT(11)                       NOT NULL,
  `created_at` DATETIME                      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME                      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_created_by` (`created_by`),
  KEY `idx_updated_at` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Who belongs to each conversation
CREATE TABLE IF NOT EXISTS `chat_participants` (
  `id`              INT(11)  NOT NULL AUTO_INCREMENT,
  `conversation_id` INT(11)  NOT NULL,
  `user_id`         INT(11)  NOT NULL,
  `joined_at`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_read_at`    DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_participant` (`conversation_id`, `user_id`),
  KEY `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every message in a conversation
CREATE TABLE IF NOT EXISTS `chat_messages` (
  `id`              INT(11)                        NOT NULL AUTO_INCREMENT,
  `conversation_id` INT(11)                        NOT NULL,
  `sender_id`       INT(11)                        NOT NULL,
  `message_type`    ENUM('text','image','file')    NOT NULL DEFAULT 'text',
  `content`         TEXT                           DEFAULT NULL,
  `created_at`      DATETIME                       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `deleted_at`      DATETIME                       DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_conversation_created` (`conversation_id`, `created_at`),
  KEY `idx_sender_id` (`sender_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- File attachments linked to messages
CREATE TABLE IF NOT EXISTS `chat_message_files` (
  `id`            INT(11)       NOT NULL AUTO_INCREMENT,
  `message_id`    INT(11)       NOT NULL,
  `original_name` VARCHAR(255)  NOT NULL,
  `stored_name`   VARCHAR(255)  NOT NULL,
  `file_path`     VARCHAR(500)  NOT NULL,
  `file_type`     VARCHAR(100)  NOT NULL,
  `file_size`     INT(11)       NOT NULL,
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_message_id` (`message_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
