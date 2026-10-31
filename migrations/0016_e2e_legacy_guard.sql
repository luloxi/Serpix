-- Guardia de texto plano (aditiva). Un INSERT o UPDATE en las tablas heredadas aborta
-- cuando la cuenta no está en modo server: cierra la carrera entre el chequeo del request
-- y el write, y también un modo desconocido. Si no hay fila en user, decide la clave foránea.

CREATE TRIGGER IF NOT EXISTS contacts_e2e_guard_insert BEFORE INSERT ON contacts FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;
CREATE TRIGGER IF NOT EXISTS contacts_e2e_guard_update BEFORE UPDATE ON contacts FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;

CREATE TRIGGER IF NOT EXISTS financial_transactions_e2e_guard_insert BEFORE INSERT ON financial_transactions FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;
CREATE TRIGGER IF NOT EXISTS financial_transactions_e2e_guard_update BEFORE UPDATE ON financial_transactions FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;

CREATE TRIGGER IF NOT EXISTS documents_e2e_guard_insert BEFORE INSERT ON documents FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;
CREATE TRIGGER IF NOT EXISTS documents_e2e_guard_update BEFORE UPDATE ON documents FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;

CREATE TRIGGER IF NOT EXISTS time_entries_e2e_guard_insert BEFORE INSERT ON time_entries FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;
CREATE TRIGGER IF NOT EXISTS time_entries_e2e_guard_update BEFORE UPDATE ON time_entries FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;

CREATE TRIGGER IF NOT EXISTS receipts_e2e_guard_insert BEFORE INSERT ON receipts FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;
CREATE TRIGGER IF NOT EXISTS receipts_e2e_guard_update BEFORE UPDATE ON receipts FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;

CREATE TRIGGER IF NOT EXISTS recurring_rules_e2e_guard_insert BEFORE INSERT ON recurring_rules FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;
CREATE TRIGGER IF NOT EXISTS recurring_rules_e2e_guard_update BEFORE UPDATE ON recurring_rules FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;

CREATE TRIGGER IF NOT EXISTS activities_e2e_guard_insert BEFORE INSERT ON activities FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;
CREATE TRIGGER IF NOT EXISTS activities_e2e_guard_update BEFORE UPDATE ON activities FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;

CREATE TRIGGER IF NOT EXISTS projects_e2e_guard_insert BEFORE INSERT ON projects FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;
CREATE TRIGGER IF NOT EXISTS projects_e2e_guard_update BEFORE UPDATE ON projects FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;

CREATE TRIGGER IF NOT EXISTS tasks_e2e_guard_insert BEFORE INSERT ON tasks FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;
CREATE TRIGGER IF NOT EXISTS tasks_e2e_guard_update BEFORE UPDATE ON tasks FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;

CREATE TRIGGER IF NOT EXISTS financial_accounts_e2e_guard_insert BEFORE INSERT ON financial_accounts FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;
CREATE TRIGGER IF NOT EXISTS financial_accounts_e2e_guard_update BEFORE UPDATE ON financial_accounts FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;

CREATE TRIGGER IF NOT EXISTS timer_state_e2e_guard_insert BEFORE INSERT ON timer_state FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;
CREATE TRIGGER IF NOT EXISTS timer_state_e2e_guard_update BEFORE UPDATE ON timer_state FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;
